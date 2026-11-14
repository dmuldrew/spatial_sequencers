"""Aggregate Terra MODIS GeoTIFF bands into H3 cells using raster_h3.

Uses https://github.com/dmuldrew/raster_h3 (Python package or `raster-h3-cli`)
for streaming GeoTIFF decoding, CRS reprojection to WGS84, bbox pruning, and H3 binning.

Usage: python3 scripts/prepare_midwest.py path/to/geotiffs
"""
import argparse
import json
import math
import shutil
import subprocess
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
TEMPERATURE_DATES = ('A2024193', 'A2024201')
VEGETATION_DATE = 'A2024193'
TILES = ('h10v04', 'h11v04')
MODIS_SINUSOIDAL_PROJ = '+proj=sinu +lon_0=0 +x_0=0 +y_0=0 +R=6371007.181 +units=m +no_defs'

# Average hexagon area (m^2) by H3 resolution 0..10 (avoids external h3 dependency).
H3_AVG_AREA_M2 = (
    4_357_449_416_078.383,
    609_788_441_794.134,
    86_801_780_398.997,
    12_393_434_655.088,
    1_770_347_654.491,
    252_903_858.182,
    36_129_062.164,
    5_161_293.360,
    737_327.598,
    105_332.513,
    15_047.502,
)

INPUTS = {
    'A1': {
        'product': 'MOD11A2', 'band': 'LST_Day_1km', 'units': '°C',
        'resolutionMeters': 1000,
    },
    'A2': {
        'product': 'MOD13Q1', 'band': '250m_16_days_NDVI', 'units': 'NDVI',
        'resolutionMeters': 250,
    },
}


def study_bounds():
    """Match the browser's 180 × 120 mile box centered on 42°N, 93.5°W."""
    latitude, longitude = 42.0, -93.5
    angle = math.radians(latitude)
    meters_per_degree_lat = 111132.92 - 559.82 * math.cos(2 * angle) + 1.175 * math.cos(4 * angle)
    meters_per_degree_lon = 111412.84 * math.cos(angle) - 93.5 * math.cos(3 * angle)
    half_width = 90 * 1609.344 / meters_per_degree_lon
    half_height = 60 * 1609.344 / meters_per_degree_lat
    return longitude - half_width, latitude - half_height, longitude + half_width, latitude + half_height


def find_band_file(folder, product, date, tile, band, source_items):
    files = list(folder.glob(f'{product}.{date}.{tile}.061.*_{band}.tif'))
    if len(files) != 1:
        raise ValueError(f'Expected one {product} {date} {tile} {band} GeoTIFF in {folder}')
    source_items.add(files[0].stem.removesuffix(f'_{band}'))
    return files[0]


def _scan_with_python_api(paths, resolution, bounds, crs, categorical=False, raw_values=False):
    import raster_h3

    if raw_values:
        # Python API applies GDAL scale/offset by default; fall back to CLI when raw DNs are needed.
        return None

    columns = (
        ['h3_hex', 'class_id', 'count', 'total_count']
        if categorical
        else ['h3_hex', 'sum', 'count']
    )
    kwargs = {
        'resolutions': resolution,
        'bbox': bounds,
        'columns': columns,
        'categorical': categorical,
    }
    if categorical:
        kwargs['format'] = 'long'
    if crs:
        kwargs['crs'] = crs

    source = ','.join(str(p) for p in paths)
    data = raster_h3.RasterH3ArrowStream(source, **kwargs).to_dict()
    if not data:
        return []
    keys = list(data.keys())
    n_rows = len(data[keys[0]])
    return [{k: data[k][i] for k in keys} for i in range(n_rows)]


def _scan_with_cli(paths, resolution, bounds, crs, categorical=False, raw_values=False, cli_bin=None):
    exe = cli_bin or shutil.which('raster-h3-cli') or shutil.which('raster-h3')
    if not exe:
        raise RuntimeError(
            'Could not find `raster_h3` Python package or `raster-h3-cli` executable. '
            'Install from https://github.com/dmuldrew/raster_h3.'
        )

    columns = 'h3_hex,class_id,count,total_count' if categorical else 'h3_hex,sum,count'
    bbox_arg = ','.join(f'{v:.8f}' for v in bounds)
    source = ','.join(str(p) for p in paths)
    cmd = [
        exe,
        'jsonl',
        source,
        '-r',
        str(resolution),
        '--bbox',
        bbox_arg,
        '--columns',
        columns,
    ]
    if categorical:
        cmd.extend(['-c', '--format', 'long'])
    if raw_values:
        cmd.append('--raw-values')
    if crs:
        cmd.extend(['--crs', crs])

    proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
    rows = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def scan_raster_h3(paths, resolution, bounds, crs=None, categorical=False, raw_values=False, cli_bin=None):
    """Run H3 aggregation via raster_h3 Python bindings or CLI."""
    try:
        rows = _scan_with_python_api(
            paths, resolution, bounds, crs, categorical=categorical, raw_values=raw_values
        )
        if rows is not None:
            return rows
    except ImportError:
        pass
    except RuntimeError as err:
        # Retry with MODIS sinusoidal PROJ string if the GeoTIFF omits embedded CRS tags.
        if crs is None and 'CrsNotDetected' in str(err):
            return scan_raster_h3(
                paths,
                resolution,
                bounds,
                crs=MODIS_SINUSOIDAL_PROJ,
                categorical=categorical,
                raw_values=raw_values,
                cli_bin=cli_bin,
            )
        raise

    try:
        return _scan_with_cli(
            paths,
            resolution,
            bounds,
            crs,
            categorical=categorical,
            raw_values=raw_values,
            cli_bin=cli_bin,
        )
    except subprocess.CalledProcessError as err:
        if crs is None and 'CrsNotDetected' in (err.stderr or ''):
            return _scan_with_cli(
                paths,
                resolution,
                bounds,
                MODIS_SINUSOIDAL_PROJ,
                categorical=categorical,
                raw_values=raw_values,
                cli_bin=cli_bin,
            )
        raise


def good_qc_cells(qa_paths, resolution, bounds, crs, predicate, cli_bin=None):
    """Identify H3 cells whose majority QA pixel class satisfies `predicate(class_id)`."""
    rows = scan_raster_h3(
        qa_paths,
        resolution,
        bounds,
        crs=crs,
        categorical=True,
        raw_values=True,
        cli_bin=cli_bin,
    )
    by_cell = {}
    for row in rows:
        cell = row.get('h3_hex')
        cls_id = row.get('class_id')
        cnt = row.get('count') or 0
        if not cell or cls_id is None:
            continue
        prev = by_cell.get(cell)
        if prev is None or cnt > prev[1]:
            by_cell[cell] = (int(cls_id), cnt)
    return {cell for cell, (cls_id, _) in by_cell.items() if predicate(cls_id)}


def to_celsius(value):
    """Normalize LST mean to °C whether input GeoTIFF used raw DN, Kelvin, or °C."""
    if value > 2000:
        return value * 0.02 - 273.15
    if value > 150:
        return value - 273.15
    return value


def to_ndvi(value):
    """Normalize NDVI mean to [-0.2, 1.0] whether scaled or raw DN."""
    if abs(value) > 2.0:
        return value * 0.0001
    return value


def accumulate_metric(totals, rows, converter, valid_range, allowed_cells=None):
    lo, hi = valid_range
    for row in rows:
        cell = row.get('h3_hex')
        count = int(row.get('count') or 0)
        total = row.get('sum')
        if not cell or count <= 0 or total is None:
            continue
        if allowed_cells is not None and cell not in allowed_cells:
            continue
        mean_val = converter(float(total) / count)
        if not (lo <= mean_val <= hi):
            continue
        prev_sum, prev_count = totals.get(cell, (0.0, 0))
        totals[cell] = (prev_sum + mean_val * count, prev_count + count)


def prepare(folder, crs=None, cli_bin=None, skip_qc=False):
    bounds = study_bounds()
    coarsest_pixel = max(item['resolutionMeters'] for item in INPUTS.values())
    resolution = max(
        index for index, area in enumerate(H3_AVG_AREA_M2)
        if area >= coarsest_pixel ** 2
    )
    source_items = set()
    observations = {'A1': {}, 'A2': {}}

    # A1: MOD11A2 8-day daytime land surface temperature
    for date in TEMPERATURE_DATES:
        lst_paths = [
            find_band_file(folder, 'MOD11A2', date, tile, 'LST_Day_1km', source_items)
            for tile in TILES
        ]
        allowed = None
        if not skip_qc:
            qc_paths = [
                find_band_file(folder, 'MOD11A2', date, tile, 'QC_Day', source_items)
                for tile in TILES
            ]
            allowed = good_qc_cells(
                qc_paths,
                resolution,
                bounds,
                crs,
                lambda qc: ((qc & 3) == 0) and ((qc >> 6) <= 1),
                cli_bin=cli_bin,
            )
        rows = scan_raster_h3(lst_paths, resolution, bounds, crs=crs, cli_bin=cli_bin)
        accumulate_metric(observations['A1'], rows, to_celsius, (-73.15, 126.85), allowed)

    # A2: MOD13Q1 16-day NDVI
    ndvi_paths = [
        find_band_file(folder, 'MOD13Q1', VEGETATION_DATE, tile, '250m_16_days_NDVI', source_items)
        for tile in TILES
    ]
    allowed_ndvi = None
    if not skip_qc:
        rel_paths = [
            find_band_file(
                folder,
                'MOD13Q1',
                VEGETATION_DATE,
                tile,
                '250m_16_days_pixel_reliability',
                source_items,
            )
            for tile in TILES
        ]
        allowed_ndvi = good_qc_cells(
            rel_paths,
            resolution,
            bounds,
            crs,
            lambda rel: rel == 0,
            cli_bin=cli_bin,
        )
    ndvi_rows = scan_raster_h3(ndvi_paths, resolution, bounds, crs=crs, cli_bin=cli_bin)
    accumulate_metric(observations['A2'], ndvi_rows, to_ndvi, (-0.2, 1.0), allowed_ndvi)

    cell_ids = sorted(observations['A1'].keys() | observations['A2'].keys())
    cells = []
    for cell in cell_ids:
        values = {'id': cell}
        for key, totals in observations.items():
            total, count = totals.get(cell, (0.0, 0))
            values[key] = round(total / count, 5) if count else None
        cells.append(values)

    paired_count = sum(cell['A1'] is not None and cell['A2'] is not None for cell in cells)
    if not paired_count:
        raise ValueError('No H3 cells have both observations')
    print(f'{paired_count:,} paired cells; {len(cells):,} with at least one observation (via raster_h3)')
    return {
        'schemaVersion': 1,
        'inputs': INPUTS,
        'periodLabel': 'July 11–26, 2024',
        'description': 'Terra MODIS Collection 6.1 processed with raster_h3. Two 8-day temperature '
                       'composites and one 16-day vegetation composite. Only good-quality observations are included.',
        'source': {
            'provider': 'Microsoft Planetary Computer',
            'processor': 'https://github.com/dmuldrew/raster_h3',
            'items': sorted(source_items),
            'quality': {
                'A1': 'QC_Day mandatory QA = 0 and LST error flag ≤ 1 (≤ 2 K).',
                'A2': 'Pixel reliability = 0 (good data).',
            },
        },
        'h3Resolution': resolution,
        'cells': cells,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('geotiff_directory', type=Path)
    parser.add_argument('--output', type=Path, default=PROJECT / 'public/midwest/data/midwest.json')
    parser.add_argument('--crs', default=None, help='Optional source CRS override (e.g. PROJ.4 string)')
    parser.add_argument('--cli-bin', default=None, help='Optional path to raster-h3-cli binary')
    parser.add_argument('--skip-qc', action='store_true', help='Skip separate QA band filtering')
    arguments = parser.parse_args()
    dataset = prepare(
        arguments.geotiff_directory,
        crs=arguments.crs,
        cli_bin=arguments.cli_bin,
        skip_qc=arguments.skip_qc,
    )
    temporary = arguments.output.with_suffix('.tmp')
    temporary.write_text(json.dumps(dataset, ensure_ascii=False, separators=(',', ':')) + '\n')
    temporary.replace(arguments.output)


if __name__ == '__main__':
    main()
