"""Bin NASA FIRMS active-fire detections into a multi-resolution global H3 grid.

Outputs, from one pass over the input CSVs:

1. ``global_fire_h3.parquet``: every requested H3 resolution (default 0-5) in one
   table, one row per cell, keyed by ``h3_index``.
2. ``global_fire.pmtiles``: a PMTiles v3 vector pyramid of that table, written by
   raster_h3 (https://github.com/dmuldrew/raster_h3). By default it keeps resolutions
   0-4 and the ``detections`` and ``density`` properties (about 9 MB for 2001-2025),
   small enough to commit and serve from GitHub Pages. ``--pmtiles-max-resolution 5
   --pmtiles-columns all`` builds the full archive (about 121 MB), which is over
   GitHub's 100 MB file limit and needs other hosting. Each resolution fills a band
   of Web Mercator zooms (res 0: z0-1, 1: z2-3, 2: z4, 3: z5, 4: z6-7, 5: z8-9), so
   no zoom is empty. raster_h3 builds without zoom bands put each resolution at a
   single zoom and leave z1, z3, z6 and z9 empty.
3. ``lod-r{N}.arrow`` + ``manifest.json``: small level-of-detail extracts (default
   res 2-4) for the Three.js orbital flyby, which swaps levels by altitude. Arrow IPC
   (uncompressed) with typed columns and precomputed cell centres; ``--lod-format json``
   writes the older JSON form instead.

Every resolution is indexed directly from the detection coordinates, never rolled up
from finer cells, because H3 children do not tile their parent exactly.

Colour should use ``density`` (detections per km^2 per year), not raw counts: counts
grow about 7x per coarser resolution, density does not. ``manifest.json`` carries one
shared colour range for all levels so the colours do not jump when levels swap.

Input: FIRMS archive or NRT CSVs (MODIS C6.1 or VIIRS), or the yearly Parquet files
written by ``fetch_firms_archive.py`` (pass one kind, not a mix).
Required columns: latitude, longitude, acq_date, confidence, frp. ``type`` is used
when present (archive files only) to keep presumed vegetation fires (type 0).

Usage:
    python3 scripts/prepare_global_fire.py data/firms/*.csv
    python3 scripts/prepare_global_fire.py data/firms/*.csv --resolutions 0-5 \
        --lod-resolutions 2,3,4 --min-confidence 30 --vegetation-only

Dependencies: duckdb, h3 (v4), pandas, pyarrow (Arrow extracts); plus the raster_h3 Python package or the
``raster-h3-cli`` binary for the PMTiles step (skip it with ``--skip-pmtiles``).
"""
import argparse
import json
import math
import shutil
import subprocess
import time
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = PROJECT / 'public/data/global-fire'

# Suggested flyby altitude bands (km above the surface) for each LOD resolution.
# Coarse cells from high orbit, finer cells as the craft descends.
LOD_ALTITUDE_KM = {
    1: (6000, None),
    2: (3000, None),
    3: (1000, 3000),
    4: (0, 1000),
    5: (0, 400),
}


def parse_resolutions(text):
    """'0-5' or '2,3,4' -> sorted unique list of ints in 0..15."""
    values = set()
    for part in str(text).split(','):
        part = part.strip()
        if not part:
            continue
        if '-' in part:
            lo, hi = (int(v) for v in part.split('-', 1))
            values.update(range(lo, hi + 1))
        else:
            values.add(int(part))
    if not values or min(values) < 0 or max(values) > 15:
        raise argparse.ArgumentTypeError(f'Invalid H3 resolution list: {text!r}')
    return sorted(values)


def confidence_sql(column_type):
    """MODIS confidence is 0-100; VIIRS uses l/n/h. Map both onto 0-100."""
    if column_type.upper().startswith(('VARCHAR', 'STRING', 'TEXT')):
        return ("COALESCE(TRY_CAST(confidence AS INTEGER), "
                "CASE lower(confidence) WHEN 'h' THEN 90 WHEN 'high' THEN 90 "
                "WHEN 'n' THEN 60 WHEN 'nominal' THEN 60 "
                "WHEN 'l' THEN 20 WHEN 'low' THEN 20 END)")
    return 'CAST(confidence AS INTEGER)'


def load_bins(con, paths, min_confidence, vegetation_only, snap_degrees, high_confidence):
    """Read and filter detections, then pre-aggregate them onto a fine lat/lon grid.

    Snapping to ``snap_degrees`` (default 0.01 deg, about the 1 km MODIS footprint)
    collapses repeat detections at the same pixel so H3 indexing runs once per
    location instead of once per detection. All statistics kept per bin are
    additive (count, sum) or extremal (min, max), so the later H3 aggregation is
    exact with respect to the snapped coordinates.

    The cost is that detections near a cell edge can land in the neighbouring cell:
    on test data, 0.01 deg moved about 0.4% / 1.1% / 2.9% of detections at
    resolutions 3 / 4 / 5, which is inside the MODIS footprint (1 km at nadir,
    several km off-nadir). Use ``--snap-degrees 0`` for exact per-detection binning
    at the cost of indexing every detection.
    """
    csvs = [str(p) for p in paths if p.suffix.lower() != '.parquet']
    parquets = [str(p) for p in paths if p.suffix.lower() == '.parquet']
    if csvs and parquets:
        raise ValueError('Pass either CSV files or Parquet files, not a mix.')
    source = (f"read_parquet({parquets!r}, union_by_name = true)" if parquets
              else f"read_csv({csvs!r}, union_by_name = true, header = true)")
    con.execute(f'CREATE VIEW raw AS SELECT * FROM {source}')
    columns = {row[0].lower(): row[1] for row in con.execute('DESCRIBE raw').fetchall()}
    missing = {'latitude', 'longitude', 'acq_date', 'confidence', 'frp'} - columns.keys()
    if missing:
        raise ValueError(f'Input CSVs are missing required columns: {sorted(missing)}')

    filters = [
        'latitude BETWEEN -90 AND 90',
        'longitude BETWEEN -180 AND 180',
        f'conf >= {int(min_confidence)}',
    ]
    if vegetation_only:
        if 'type' in columns:
            # Rows from files without a type column (NRT) are kept.
            filters.append('(fire_type IS NULL OR fire_type = 0)')
        else:
            print('note: no `type` column (NRT files); --vegetation-only has no effect')

    type_expr = 'TRY_CAST(type AS INTEGER)' if 'type' in columns else 'NULL::INTEGER'

    if snap_degrees > 0:
        inv = 1.0 / snap_degrees
        lat_expr = f'(floor(latitude * {inv}) + 0.5) / {inv}'
        lon_expr = f'(floor(longitude * {inv}) + 0.5) / {inv}'
    else:
        lat_expr, lon_expr = 'latitude', 'longitude'

    # Detections grouped by snapped location, year and month. Locations (bins) drive the
    # H3 indexing; the per-month rows (bin_time) feed the trend and fire-season statistics.
    con.execute(f'''
        CREATE TABLE det AS
        WITH detections AS (
            SELECT CAST(latitude AS DOUBLE) AS latitude,
                   CAST(longitude AS DOUBLE) AS longitude,
                   CAST(acq_date AS DATE) AS acq_date,
                   {confidence_sql(columns['confidence'])} AS conf,
                   TRY_CAST(frp AS DOUBLE) AS frp,
                   {type_expr} AS fire_type
            FROM raw
        )
        SELECT {lat_expr} AS lat, {lon_expr} AS lon,
               CAST(year(acq_date) AS SMALLINT) AS y,
               CAST(month(acq_date) AS TINYINT) AS m,
               count(*) AS detections,
               count(*) FILTER (WHERE conf >= {int(high_confidence)}) AS high_conf_detections,
               COALESCE(sum(frp), 0) AS frp_sum,
               max(frp) AS frp_max,
               min(acq_date) AS first_date,
               max(acq_date) AS last_date
        FROM detections
        WHERE {' AND '.join(filters)}
        GROUP BY 1, 2, 3, 4
    ''')
    con.execute('''
        CREATE TABLE bins AS
        SELECT row_number() OVER (ORDER BY lat, lon) - 1 AS bin_id, *
        FROM (
            SELECT lat, lon,
                   sum(detections) AS detections,
                   sum(high_conf_detections) AS high_conf_detections,
                   sum(frp_sum) AS frp_sum,
                   max(frp_max) AS frp_max,
                   min(first_date) AS first_date,
                   max(last_date) AS last_date
            FROM det GROUP BY lat, lon
        )
    ''')
    con.execute('''
        CREATE TABLE bin_time AS
        SELECT b.bin_id, d.y, d.m, CAST(d.detections AS INTEGER) AS n
        FROM det d JOIN bins b USING (lat, lon)
    ''')
    con.execute('DROP TABLE det')
    n_bins, n_detections, first, last = con.execute(
        'SELECT count(*), COALESCE(sum(detections), 0), min(first_date), max(last_date) FROM bins'
    ).fetchone()
    if not n_detections:
        raise ValueError('No detections passed the filters.')
    return n_bins, n_detections, first, last


def index_bins(con, resolutions):
    """Index every bin centre at every resolution with h3-py and register the result."""
    import pandas as pd
    from h3.api import basic_int as h3i

    data = con.execute('SELECT bin_id, lat, lon FROM bins ORDER BY bin_id').fetchnumpy()
    lats = data['lat'].tolist()
    lons = data['lon'].tolist()
    frame = {'bin_id': data['bin_id']}
    for res in resolutions:
        cells = [h3i.latlng_to_cell(a, b, res) for a, b in zip(lats, lons)]
        # H3 indices fit in 63 bits, so they are safe as signed BIGINT.
        frame[f'r{res}'] = pd.array(cells, dtype='int64')
    con.register('bin_cells_df', pd.DataFrame(frame))
    con.execute('CREATE TABLE bin_cells AS SELECT * FROM bin_cells_df')
    con.unregister('bin_cells_df')


def aggregate_cells(con, resolutions, years, min_detections, fine_from):
    """One row per (resolution, cell), plus cell area and per-area densities."""
    from h3.api import basic_int as h3i
    import pandas as pd

    parts = []
    for res in resolutions:
        threshold = min_detections if res >= fine_from else 1
        parts.append(f'''
            SELECT c.r{res} AS h3_index, {res} AS resolution,
                   sum(b.detections) AS detections,
                   sum(b.high_conf_detections) AS high_conf_detections,
                   sum(b.frp_sum) AS frp_sum,
                   max(b.frp_max) AS frp_max,
                   year(min(b.first_date)) AS first_year,
                   year(max(b.last_date)) AS last_year
            FROM bins b JOIN bin_cells c USING (bin_id)
            GROUP BY c.r{res}
            HAVING sum(b.detections) >= {int(threshold)}
        ''')
    con.execute('CREATE TABLE cells_raw AS ' + ' UNION ALL '.join(parts))

    ids = con.execute('SELECT DISTINCT h3_index FROM cells_raw').fetchnumpy()['h3_index'].tolist()
    areas = pd.DataFrame({
        'h3_index': pd.array(ids, dtype='int64'),
        'area_km2': [h3i.cell_area(i, 'km^2') for i in ids],
    })
    con.register('areas_df', areas)
    con.execute(f'''
        CREATE TABLE cells AS
        SELECT r.h3_index,
               CAST(r.resolution AS TINYINT) AS resolution,
               CAST(r.detections AS BIGINT) AS detections,
               CAST(r.high_conf_detections AS BIGINT) AS high_conf_detections,
               round(r.frp_sum, 2) AS frp_sum,
               round(r.frp_max, 2) AS frp_max,
               CAST(r.first_year AS SMALLINT) AS first_year,
               CAST(r.last_year AS SMALLINT) AS last_year,
               round(a.area_km2, 3) AS area_km2,
               r.detections / a.area_km2 / {years} AS density,
               r.frp_sum / a.area_km2 / {years} AS frp_density
        FROM cells_raw r JOIN areas_df a USING (h3_index)
        ORDER BY r.resolution, r.h3_index
    ''')
    con.unregister('areas_df')
    return con.execute(
        'SELECT resolution, count(*), sum(detections) FROM cells GROUP BY 1 ORDER BY 1'
    ).fetchall()


def trend_windows(first_year, last_year, max_window=10):
    """Equal early and late windows of whole years, up to a decade each, or None."""
    span = last_year - first_year + 1
    window = min(max_window, span // 2)
    if window < 1:
        return None
    return (first_year, first_year + window - 1), (last_year - window + 1, last_year)


def add_temporal_stats(con, resolutions, windows):
    """Add trend_log2, peak_month and peak_share to every cell, per resolution.

    trend_log2 = log2((late + 0.5) / (early + 0.5)) on mean detections per year in the
    late and early windows (+0.5 keeps sparse cells from swinging wildly); 1.0 means
    doubled, -1.0 halved. peak_month is the calendar month (1-12) with the most
    detections over all years (ties go to the earlier month), and peak_share its
    fraction of the cell's detections. Each resolution is computed from its own cells,
    like the counts, not rolled up from finer ones. Assumes whole years at both ends.
    """
    if windows:
        (e0, e1), (l0, l1) = windows
        width = e1 - e0 + 1
        late = f'COALESCE(sum(n) FILTER (WHERE y BETWEEN {l0} AND {l1}), 0)'
        early = f'COALESCE(sum(n) FILTER (WHERE y BETWEEN {e0} AND {e1}), 0)'
        trend_sql = f'log2(({late} / {width} + 0.5) / ({early} / {width} + 0.5))'
    else:
        trend_sql = 'NULL::DOUBLE'
    parts = []
    for res in resolutions:
        parts.append(f'''
            SELECT h3_index, {res} AS resolution, trend_log2, peak_month, peak_share
            FROM (
                SELECT h3_index, {trend_sql} AS trend_log2
                FROM (
                    SELECT c.r{res} AS h3_index, t.y, sum(t.n) AS n
                    FROM bin_time t JOIN bin_cells c USING (bin_id) GROUP BY 1, 2
                ) GROUP BY h3_index
            ) yearly
            JOIN (
                SELECT h3_index,
                       arg_max(m, n * 100 - m) AS peak_month,
                       max(n) / sum(n) AS peak_share
                FROM (
                    SELECT c.r{res} AS h3_index, t.m, sum(t.n) AS n
                    FROM bin_time t JOIN bin_cells c USING (bin_id) GROUP BY 1, 2
                ) GROUP BY h3_index
            ) monthly USING (h3_index)
        ''')
    con.execute('CREATE TABLE cell_stats AS ' + ' UNION ALL '.join(parts))
    con.execute('''
        CREATE TABLE cells_t AS
        SELECT c.*,
               CAST(round(s.trend_log2, 4) AS FLOAT) AS trend_log2,
               CAST(s.peak_month AS TINYINT) AS peak_month,
               CAST(round(s.peak_share, 4) AS FLOAT) AS peak_share
        FROM cells c LEFT JOIN cell_stats s USING (h3_index, resolution)
        ORDER BY c.resolution, c.h3_index
    ''')
    con.execute('DROP TABLE cells')
    con.execute('ALTER TABLE cells_t RENAME TO cells')
    con.execute('DROP TABLE cell_stats')


def write_parquet(con, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp.parquet')
    # h3_index first: raster_h3 auto-detects it by name, and the DuckDB COPY route
    # takes the first column as the cell.
    con.execute(f"COPY cells TO '{tmp}' (FORMAT parquet, COMPRESSION zstd)")
    tmp.replace(path)


# Cell-table columns that can go into the PMTiles features. raster_h3 always adds
# h3_index, h3_hex and resolution.
PMTILES_COLUMNS = ('detections', 'high_conf_detections', 'frp_sum', 'frp_max', 'first_year',
                   'last_year', 'area_km2', 'density', 'frp_density', 'trend_log2',
                   'peak_month', 'peak_share')
GITHUB_WARN_BYTES = 50 * 1024 * 1024
GITHUB_LIMIT_BYTES = 100 * 1024 * 1024


def parse_pmtiles_columns(text):
    """'all' or a comma list of PMTILES_COLUMNS."""
    if text.strip().lower() == 'all':
        return list(PMTILES_COLUMNS)
    columns = [c.strip() for c in text.split(',') if c.strip()]
    unknown = sorted(set(columns) - set(PMTILES_COLUMNS))
    if unknown:
        raise argparse.ArgumentTypeError(
            f'Unknown PMTiles column(s) {unknown}; choose from {", ".join(PMTILES_COLUMNS)} or "all"'
        )
    return columns


def write_pmtiles_subset(con, out_dir, pmtiles_path, max_resolution, columns, cli_bin=None):
    """Write the chosen resolutions and properties to a temporary Parquet, then tile it."""
    subset = out_dir / 'global_fire_pmtiles_input.tmp.parquet'
    select = ', '.join(['h3_index', *columns])
    con.execute(f"""
        COPY (SELECT {select} FROM cells WHERE resolution <= {int(max_resolution)})
        TO '{subset}' (FORMAT parquet, COMPRESSION zstd)
    """)
    try:
        write_pmtiles(subset, pmtiles_path, cli_bin)
    finally:
        subset.unlink(missing_ok=True)
    size = pmtiles_path.stat().st_size
    if size > GITHUB_LIMIT_BYTES:
        print(f'warning: {pmtiles_path.name} is over GitHub\'s 100 MB file limit; '
              'host it outside git (e.g. R2, S3) or lower --pmtiles-max-resolution')
    elif size > GITHUB_WARN_BYTES:
        print(f'warning: {pmtiles_path.name} is over 50 MB; GitHub warns about files this size '
              'and every regeneration stays in git history')
    return size


def write_pmtiles(parquet_path, pmtiles_path, cli_bin=None):
    """Transcode an H3 Parquet table (h3_index first) to PMTiles with raster_h3."""
    pmtiles_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        import raster_h3
        if hasattr(raster_h3, 'parquet_to_pmtiles'):
            return raster_h3.parquet_to_pmtiles(parquet_path, pmtiles_path, h3_column='h3_index')
    except ImportError:
        pass
    exe = cli_bin or shutil.which('raster-h3-cli')
    if not exe:
        raise RuntimeError(
            'PMTiles step needs the raster_h3 Python package or the `raster-h3-cli` binary '
            '(https://github.com/dmuldrew/raster_h3). Re-run with --skip-pmtiles to stop at Parquet.'
        )
    subprocess.run(
        [exe, 'parquet-to-pmtiles', str(parquet_path), '-o', str(pmtiles_path),
         '--h3-column', 'h3_index'],
        check=True,
    )
    return None


def quantile(sorted_values, fraction):
    if not sorted_values:
        return None
    pos = (len(sorted_values) - 1) * fraction
    lo, hi = math.floor(pos), math.ceil(pos)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo)


def write_lod_arrow(path, res, rows, period_label, color_range):
    """Uncompressed Arrow IPC file: typed columns the browser reads without parsing.

    Buffers stay uncompressed because Apache Arrow JS cannot read LZ4/Zstd IPC buffers;
    rely on HTTP compression instead. Cell centres are precomputed so the flyby can
    place hexagons without an h3-js call per cell.
    """
    import pyarrow as pa
    from h3.api import basic_int as h3i

    centres = [h3i.cell_to_latlng(row[0]) for row in rows]
    column = lambda i: [row[i] for row in rows]  # noqa: E731
    table = pa.table({
        'h3_index': pa.array(column(0), pa.uint64()),
        'lat': pa.array([c[0] for c in centres], pa.float32()),
        'lng': pa.array([c[1] for c in centres], pa.float32()),
        'detections': pa.array(column(1), pa.uint32()),
        'density': pa.array([float(v) for v in column(2)], pa.float32()),
        'frp_max': pa.array(column(3), pa.float32()),
        'trend_log2': pa.array(column(4), pa.float32()),
        'peak_month': pa.array(column(5), pa.uint8()),
        'peak_share': pa.array(column(6), pa.float32()),
    })
    table = table.replace_schema_metadata({
        'schemaVersion': '1',
        'resolution': str(res),
        'periodLabel': period_label,
        'colorRange': json.dumps(color_range),
    })
    tmp = path.with_name(path.name + '.tmp')
    with pa.OSFile(str(tmp), 'wb') as sink, pa.ipc.new_file(sink, table.schema) as writer:
        writer.write_table(table)
    tmp.replace(path)


def write_lod_json(path, res, rows, period_label):
    payload = {
        'schemaVersion': 1,
        'resolution': res,
        'periodLabel': period_label,
        'fields': ['id', 'detections', 'density', 'frpMax', 'trendLog2', 'peakMonth', 'peakShare'],
        'cells': [
            [format(cell, 'x'), detections, float(f'{density:.4g}'),
             None if frp_max is None else round(frp_max, 1),
             None if trend is None else round(trend, 3), peak_month,
             None if peak_share is None else round(peak_share, 3)]
            for cell, detections, density, frp_max, trend, peak_month, peak_share in rows
        ],
    }
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(payload, separators=(',', ':')) + '\n')
    tmp.replace(path)


def write_lod(con, out_dir, lod_resolutions, period_label, years, meta, lod_format='arrow'):
    """Per-resolution flyby extracts (Arrow or JSON) plus a manifest with a shared colour range."""
    out_dir.mkdir(parents=True, exist_ok=True)
    present = {row[0] for row in con.execute('SELECT DISTINCT resolution FROM cells').fetchall()}
    levels = [res for res in lod_resolutions if res in present]

    # One colour range for all levels, on log10(density): densities span orders of
    # magnitude, and sharing the range keeps colours stable when levels swap.
    placeholders = ','.join(str(r) for r in levels) or '-1'
    log_density = sorted(
        row[0] for row in con.execute(
            f'SELECT log10(density) FROM cells WHERE resolution IN ({placeholders}) AND density > 0'
        ).fetchall()
    )
    color_range = {
        'field': 'density',
        'scale': 'log10',
        'min': round(quantile(log_density, 0.05), 4) if log_density else None,
        'max': round(quantile(log_density, 0.95), 4) if log_density else None,
    }

    files = []
    for res in levels:
        rows = con.execute(f'''
            SELECT h3_index, detections, density, frp_max, trend_log2, peak_month, peak_share
            FROM cells WHERE resolution = {res} ORDER BY h3_index
        ''').fetchall()
        name = f'lod-r{res}.{lod_format}'
        if lod_format == 'arrow':
            write_lod_arrow(out_dir / name, res, rows, period_label, color_range)
        else:
            write_lod_json(out_dir / name, res, rows, period_label)
        lo, hi = LOD_ALTITUDE_KM.get(res, (None, None))
        files.append({
            'resolution': res,
            'file': name,
            'format': lod_format,
            'cells': len(rows),
            'altitudeKm': {'min': lo, 'max': hi},
        })

    # Drop extracts this job wrote earlier that the new manifest no longer lists.
    written = {f['file'] for f in files}
    for old in [*out_dir.glob('lod-r*.json'), *out_dir.glob('lod-r*.arrow')]:
        if old.name not in written:
            old.unlink()

    manifest = {
        'schemaVersion': 1,
        'periodLabel': period_label,
        'years': years,
        'densityUnits': 'detections per km² per year',
        'colorRange': color_range,
        'levels': files,
        **meta,
    }
    (out_dir / 'manifest.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'
    )
    return files


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('csv', nargs='+', type=Path,
                        help='FIRMS CSV files (MODIS or VIIRS) or fetch_firms_archive.py Parquet files')
    parser.add_argument('--resolutions', type=parse_resolutions, default=parse_resolutions('0-5'),
                        help='H3 resolutions for Parquet/PMTiles (default 0-5)')
    parser.add_argument('--lod-resolutions', type=parse_resolutions,
                        default=parse_resolutions('2,3,4'),
                        help='Resolutions to extract for the flyby (default 2,3,4)')
    parser.add_argument('--lod-format', choices=('arrow', 'json'), default='arrow',
                        help='Flyby extract format (default arrow; needs pyarrow)')
    parser.add_argument('--min-confidence', type=int, default=30,
                        help='Drop detections below this confidence, 0-100 (default 30)')
    parser.add_argument('--high-confidence', type=int, default=80,
                        help='Confidence counted in high_conf_detections (default 80)')
    parser.add_argument('--vegetation-only', action='store_true',
                        help='Keep only presumed vegetation fires (archive `type` = 0)')
    parser.add_argument('--snap-degrees', type=float, default=0.01,
                        help='Pre-aggregation grid in degrees; 0 disables (default 0.01)')
    parser.add_argument('--min-detections', type=int, default=2,
                        help='Minimum detections for cells at --fine-from and finer (default 2)')
    parser.add_argument('--fine-from', type=int, default=4,
                        help='First resolution the --min-detections filter applies to (default 4)')
    parser.add_argument('--out-dir', type=Path, default=DEFAULT_OUT,
                        help=f'Output directory (default {DEFAULT_OUT.relative_to(PROJECT)})')
    parser.add_argument('--skip-pmtiles', action='store_true', help='Stop after Parquet + LOD extracts')
    parser.add_argument('--pmtiles-max-resolution', type=int, default=4,
                        help='Finest H3 resolution in the PMTiles (default 4: ~9 MB, commit-sized; '
                             '5 roughly 6x larger)')
    parser.add_argument('--pmtiles-columns', type=parse_pmtiles_columns,
                        default=parse_pmtiles_columns('detections,density,trend_log2,peak_month'),
                        help='Feature properties in the PMTiles: comma list or "all" '
                             '(default detections,density,trend_log2,peak_month)')
    parser.add_argument('--cli-bin', default=None, help='Path to raster-h3-cli')
    parser.add_argument('--threads', type=int, default=None, help='DuckDB threads')
    args = parser.parse_args()

    import duckdb

    resolutions = sorted(set(args.resolutions) | set(args.lod_resolutions))
    for path in args.csv:
        if not path.is_file():
            parser.error(f'Not a file: {path}')

    started = time.perf_counter()
    con = duckdb.connect()
    if args.threads:
        con.execute(f'SET threads = {int(args.threads)}')

    n_bins, n_detections, first, last = load_bins(
        con, args.csv, args.min_confidence, args.vegetation_only,
        args.snap_degrees, args.high_confidence,
    )
    years = max((last - first).days + 1, 1) / 365.25
    period_label = f'{first.isoformat()} – {last.isoformat()}'
    print(f'{n_detections:,} detections -> {n_bins:,} snapped locations ({period_label}) '
          f'[{time.perf_counter() - started:.1f}s]')

    index_bins(con, resolutions)
    print(f'indexed at resolutions {resolutions} [{time.perf_counter() - started:.1f}s]')

    summary = aggregate_cells(con, resolutions, years, args.min_detections, args.fine_from)
    for res, cells, detections in summary:
        print(f'  res {res:>2}: {cells:>10,} cells, {int(detections):>12,} detections')

    windows = trend_windows(first.year, last.year)
    add_temporal_stats(con, resolutions, windows)
    print(f'trend windows {windows}, peak months [{time.perf_counter() - started:.1f}s]')

    parquet_path = args.out_dir / 'global_fire_h3.parquet'
    write_parquet(con, parquet_path)
    print(f'wrote {parquet_path} ({parquet_path.stat().st_size / 1e6:.1f} MB) '
          f'[{time.perf_counter() - started:.1f}s]')

    meta = {
        'description': 'NASA FIRMS active-fire detections binned to H3 at each resolution '
                       'directly from detection coordinates.',
        'source': {
            'provider': 'NASA FIRMS',
            'files': sorted(p.name for p in args.csv),
            'filters': {
                'minConfidence': args.min_confidence,
                'vegetationOnly': args.vegetation_only,
                'snapDegrees': args.snap_degrees,
                'minDetections': {'value': args.min_detections, 'fromResolution': args.fine_from},
            },
            'processor': 'https://github.com/dmuldrew/raster_h3',
        },
        'trend': None if not windows else {
            'field': 'trend_log2',
            'early': list(windows[0]),
            'late': list(windows[1]),
            'definition': 'log2((late mean detections per year + 0.5) / (early mean + 0.5))',
        },
        'season': {
            'fields': ['peak_month', 'peak_share'],
            'definition': 'calendar month (1-12) with the most detections, and its share of the cell total',
        },
        'resolutions': [row[0] for row in summary],
    }

    if not args.skip_pmtiles:
        pmtiles_path = args.out_dir / 'global_fire.pmtiles'
        size = write_pmtiles_subset(con, args.out_dir, pmtiles_path, args.pmtiles_max_resolution,
                                    args.pmtiles_columns, args.cli_bin)
        print(f'wrote {pmtiles_path} ({size / 1e6:.1f} MB, resolutions '
              f'0-{args.pmtiles_max_resolution}, properties {",".join(args.pmtiles_columns)}) '
              f'[{time.perf_counter() - started:.1f}s]')
        meta['pmtiles'] = {
            'file': pmtiles_path.name,
            'maxResolution': args.pmtiles_max_resolution,
            'properties': args.pmtiles_columns,
        }

    levels = write_lod(con, args.out_dir, args.lod_resolutions, period_label, round(years, 3), meta,
                       args.lod_format)
    for level in levels:
        print(f'  {level["file"]}: {level["cells"]:,} cells')
    print(f'done in {time.perf_counter() - started:.1f}s')


if __name__ == '__main__':
    main()
