"""Download the NASA FIRMS MODIS yearly country archives and convert them to Parquet.

FIRMS publishes one zip per year (``modis_<year>_all_countries.zip``, 30-90 MB) holding
a CSV per country with the standard archive columns, including ``type``. Each year is
downloaded with resume and retries (FIRMS connections reset now and then), its CSVs are
read with DuckDB, and the columns ``prepare_global_fire.py`` needs are written to one
zstd Parquet file per year (about 5x smaller than the CSVs). Extracted CSVs are deleted;
zips are kept with ``--keep-zips``.

Country files only include detections FIRMS assigned to a country, so offshore
detections (mostly gas flares, ``type`` 3) are absent.

Usage:
    python3 scripts/fetch_firms_archive.py --years 2001-2025 --out-dir data/firms
    python3 scripts/prepare_global_fire.py data/firms/modis_*.parquet --vegetation-only
"""
import argparse
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path

BASE_URL = 'https://firms.modaps.eosdis.nasa.gov/data/country/zips'
COLUMNS = ('latitude', 'longitude', 'acq_date', 'acq_time', 'satellite', 'confidence',
           'frp', 'daynight', 'type')


def parse_years(text):
    years = set()
    for part in text.split(','):
        part = part.strip()
        if '-' in part:
            lo, hi = (int(v) for v in part.split('-', 1))
            years.update(range(lo, hi + 1))
        elif part:
            years.add(int(part))
    return sorted(years)


def download(url, path, attempts=8):
    """curl with resume; FIRMS resets connections intermittently."""
    for attempt in range(1, attempts + 1):
        result = subprocess.run(
            ['curl', '-sS', '--fail', '--max-time', '900', '-C', '-', '-o', str(path), url],
            capture_output=True, text=True,
        )
        if result.returncode == 0:
            return
        # 33: server ignored the resume range on a complete file; treat as done.
        if result.returncode == 33 and path.exists():
            return
        if result.returncode == 22 and '404' in result.stderr:
            raise FileNotFoundError(url)
        wait = min(2 ** attempt, 30)
        print(f'  retry {attempt}/{attempts} in {wait}s: {result.stderr.strip()}')
        time.sleep(wait)
    raise RuntimeError(f'Could not download {url}')


def convert(zip_path, parquet_path, con):
    with tempfile.TemporaryDirectory(dir=parquet_path.parent) as tmp:
        with zipfile.ZipFile(zip_path) as archive:
            members = [m for m in archive.namelist() if m.lower().endswith('.csv')]
            archive.extractall(tmp, members)
        files = [str(Path(tmp) / m) for m in members]
        select = ', '.join(COLUMNS)
        tmp_out = parquet_path.with_suffix('.tmp.parquet')
        # All columns as text first: some country files are empty or infer odd types.
        con.execute(f'''
            COPY (
                SELECT CAST(latitude AS DOUBLE) AS latitude,
                       CAST(longitude AS DOUBLE) AS longitude,
                       CAST(acq_date AS DATE) AS acq_date,
                       acq_time, satellite,
                       TRY_CAST(confidence AS INTEGER) AS confidence,
                       TRY_CAST(frp AS DOUBLE) AS frp,
                       daynight,
                       TRY_CAST(type AS INTEGER) AS type
                FROM read_csv({files!r}, union_by_name = true, header = true,
                              all_varchar = true)
                WHERE latitude IS NOT NULL
            ) TO '{tmp_out}' (FORMAT parquet, COMPRESSION zstd)
        ''')
        tmp_out.replace(parquet_path)
    return con.execute(f"SELECT count(*) FROM '{parquet_path}'").fetchone()[0]


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('--years', type=parse_years, default=parse_years('2001-2025'))
    parser.add_argument('--out-dir', type=Path, required=True)
    parser.add_argument('--keep-zips', action='store_true')
    parser.add_argument('--force', action='store_true', help='Rebuild existing Parquet files')
    args = parser.parse_args()

    import duckdb

    args.out_dir.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    total = 0
    for year in args.years:
        parquet_path = args.out_dir / f'modis_{year}.parquet'
        if parquet_path.exists() and not args.force:
            rows = con.execute(f"SELECT count(*) FROM '{parquet_path}'").fetchone()[0]
            print(f'{year}: {rows:,} detections (existing)')
            total += rows
            continue
        zip_path = args.out_dir / f'modis_{year}_all_countries.zip'
        started = time.perf_counter()
        try:
            download(f'{BASE_URL}/{zip_path.name}', zip_path)
        except FileNotFoundError:
            print(f'{year}: not published, skipped')
            continue
        rows = convert(zip_path, parquet_path, con)
        total += rows
        if not args.keep_zips:
            zip_path.unlink()
        size = parquet_path.stat().st_size / 1e6
        print(f'{year}: {rows:,} detections, {size:.1f} MB '
              f'[{time.perf_counter() - started:.0f}s]')
    print(f'total: {total:,} detections')


if __name__ == '__main__':
    main()
