"""Crop Terra MODIS GeoTIFF bands to the study box and prepare H3 map blocks.

Usage: python3 scripts/prepare_midwest_blocks.py path/to/geotiffs [--blocks DIR | --output FILE]
Requires rasterio, numpy, h3 (v4) and raster-h3 (v0.7.0). See README for source asset names.
"""
import argparse
import hashlib
import json
import math
from statistics import quantiles
from pathlib import Path
from tempfile import TemporaryDirectory
from time import perf_counter

import h3
import numpy as np
import raster_h3
import rasterio
from rasterio.transform import array_bounds
from rasterio.warp import Resampling, aligned_target, calculate_default_transform, reproject, transform_bounds
from rasterio.windows import Window, from_bounds


PROJECT = Path(__file__).resolve().parents[1]
TEMPERATURE_DATES = ('A2024193', 'A2024201')
VEGETATION_DATE = 'A2024193'
TILES = ('h10v04', 'h11v04')
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


def read_window(path, bounds):
    with rasterio.open(path) as raster:
        projected = transform_bounds('EPSG:4326', raster.crs, *bounds, densify_pts=41)
        extent = from_bounds(*projected, raster.transform)
        left = math.floor(extent.col_off)
        top = math.floor(extent.row_off)
        right = math.ceil(extent.col_off + extent.width)
        bottom = math.ceil(extent.row_off + extent.height)
        window = Window(left, top, right - left, bottom - top)
        window = window.intersection(Window(0, 0, raster.width, raster.height))
        return raster.read(1, window=window), raster.window_transform(window), raster.crs


def read_band(folder, product, date, tile, band, bounds, source_items):
    files = list(folder.glob(f'{product}.{date}.{tile}.061.*_{band}.tif'))
    if len(files) != 1:
        raise ValueError(f'Expected one {product} {date} {tile} {band} GeoTIFF')
    source_items.add(files[0].stem.removesuffix(f'_{band}'))
    return read_window(files[0], bounds)


def paired_bands(folder, product, date, tile, band, quality_band, bounds, source_items):
    raw, grid, crs = read_band(folder, product, date, tile, band, bounds, source_items)
    quality, qa_grid, qa_crs = read_band(folder, product, date, tile, quality_band, bounds, source_items)
    if (raw.shape, grid, crs) != (quality.shape, qa_grid, qa_crs):
        raise ValueError(f'Mismatched data and QA grids in {product} {date} {tile}')
    return raw, quality, grid, crs


def temperature(folder, tile, bounds, source_items, dates):
    parts = [
        paired_bands(folder, 'MOD11A2', date, tile, 'LST_Day_1km', 'QC_Day', bounds, source_items)
        for date in dates
    ]
    raw, _, grid, crs = parts[0]
    sums = np.zeros(raw.shape, dtype=np.float64)
    counts = np.zeros(raw.shape, dtype=np.uint8)
    for raw, quality, part_grid, part_crs in parts:
        if (grid, crs, raw.shape) != (part_grid, part_crs, sums.shape):
            raise ValueError(f'Mismatched temperature grids in {tile}')
        # QC value zero is good data. Read the QA band as raw integers because
        # some GeoTIFF copies also declare zero as nodata.
        valid = (raw >= 7500) & (raw <= 20000) & ((quality & 3) == 0) & ((quality >> 6) <= 1)
        sums[valid] += raw[valid] * 0.02 - 273.15
        counts[valid] += 1
    means = np.divide(sums, counts, out=np.full_like(sums, np.nan), where=counts > 0)
    return means, grid, crs


def vegetation(folder, tile, bounds, source_items, dates):
    raw, quality, grid, crs = paired_bands(
        folder, 'MOD13Q1', dates[0], tile, '250m_16_days_NDVI',
        '250m_16_days_pixel_reliability', bounds, source_items,
    )
    # Reliability class 0 identifies good observations.
    valid = (raw >= -2000) & (raw <= 10000) & (quality == 0)
    return np.where(valid, raw * 0.0001, np.nan), grid, crs


def project_for_aggregation(raster, grid, crs, path, target_crs):
    # raster_h3 v0.7.0 cannot read the MODIS sinusoidal CRS. Use a common
    # CONUS equal-area grid at each input's native pixel spacing.
    height, width = raster.shape
    bounds = array_bounds(height, width, grid)
    pixel_size = (abs(grid.a), abs(grid.e))
    transform, width, height = calculate_default_transform(
        crs, target_crs, width, height, *bounds, resolution=pixel_size,
    )
    transform, width, height = aligned_target(transform, width, height, pixel_size)
    nodata = -9999.0
    with rasterio.open(
        path, 'w', driver='GTiff', count=1, dtype='float64', width=width, height=height,
        crs=target_crs, transform=transform, nodata=nodata,
    ) as target:
        reproject(
            source=np.where(np.isfinite(raster), raster, nodata),
            destination=rasterio.band(target, 1), src_transform=grid, src_crs=crs,
            src_nodata=nodata, dst_nodata=nodata, resampling=Resampling.nearest,
        )


def accumulate(totals, path, bounds, resolution, crs):
    rows = raster_h3.RasterH3ArrowStream(
        path, resolution, crs=crs, bbox=bounds, sampling='center',
        columns=['h3_hex', 'sum', 'count'], strict_transforms=True,
    ).to_dict()
    for cell, value, count in zip(rows['h3_hex'], rows['sum'], rows['count'], strict=True):
        previous_sum, previous_count = totals.get(cell, (0.0, 0))
        totals[cell] = previous_sum + value, previous_count + count


def prepare(folder, bounds=None, tiles=TILES, *, allow_empty=False,
            bands_by_tile=None, crs='EPSG:5070'):
    bounds = bounds or study_bounds()
    coarsest_pixel = max(item['resolutionMeters'] for item in INPUTS.values())
    resolution = max(index for index in range(11)
                     if h3.average_hexagon_area(index, 'm^2') >= coarsest_pixel ** 2)
    source_items = set()
    observations = {'A1': {}, 'A2': {}}
    preparation_seconds = 0.0
    aggregation_seconds = 0.0
    with TemporaryDirectory(prefix='modis-h3-') as scratch:
        for key, read, dates in (('A1', temperature, TEMPERATURE_DATES),
                                 ('A2', vegetation, (VEGETATION_DATE,))):
            for tile in tiles:
                tile_dates = bands_by_tile[tile][key] if bands_by_tile is not None else dates
                if not tile_dates:
                    continue
                start = perf_counter()
                try:
                    raster, grid, source_crs = read(folder, tile, bounds, source_items, tile_dates)
                except rasterio.errors.WindowError:
                    continue
                projected = Path(scratch) / f'{key}-{tile}.tif'
                project_for_aggregation(raster, grid, source_crs, projected, crs)
                preparation_seconds += perf_counter() - start

                start = perf_counter()
                accumulate(observations[key], projected, bounds, resolution, crs)
                aggregation_seconds += perf_counter() - start
    print(f'Crop, QA and reproject: {preparation_seconds:.2f}s; raster_h3: {aggregation_seconds:.2f}s')
    cell_ids = sorted(observations['A1'].keys() | observations['A2'].keys())
    cells = []
    for cell in cell_ids:
        values = {'id': cell}
        for key, totals in observations.items():
            total, count = totals.get(cell, (0.0, 0))
            values[key] = round(total / count, 5) if count else None
        cells.append(values)
    paired_count = sum(cell['A1'] is not None and cell['A2'] is not None for cell in cells)
    if not paired_count and not allow_empty:
        raise ValueError('No H3 cells have both observations')
    print(f'{paired_count:,} paired cells; {len(cells):,} with at least one observation')
    return {
        'schemaVersion': 1,
        'inputs': INPUTS,
        'periodLabel': 'July 11–26, 2024',
        'description': 'Terra MODIS Collection 6.1. Two 8-day temperature composites and one '
                       '16-day vegetation composite. Only good-quality observations are included.',
        'source': {
            'provider': 'Microsoft Planetary Computer',
            'items': sorted(source_items),
            'aggregation': 'raster_h3 v0.7.0; pixel-center means after nearest-neighbor '
                           'reprojection to EPSG:5070 at native pixel spacing.',
            'quality': {
                'A1': 'QC_Day mandatory QA = 0 and LST error flag ≤ 1 (≤ 2 K).',
                'A2': 'Pixel reliability = 0 (good data).',
            },
        },
        'h3Resolution': resolution,
        'cells': cells,
    }


def mercator_y(latitude):
    return math.degrees(math.asinh(math.tan(math.radians(latitude))))


def latitude_at(y):
    return math.degrees(math.atan(math.sinh(math.radians(y))))


def build_blocks(folder, destination):
    west, south, east, north = study_bounds()
    longitude = (east + west) / 2
    y = (mercator_y(south) + mercator_y(north)) / 2
    dx = (east - west) / 2
    dy = (mercator_y(north) - mercator_y(south)) / 2
    x_edges = [longitude + (i - 2.5) * dx for i in range(6)]
    y_edges = [y + (i - 2.5) * dy for i in range(6)]
    # The two available MODIS tiles start at 40°N.
    y_edges[0] = max(y_edges[0], mercator_y(40.01))
    coverage = (x_edges[0], latitude_at(y_edges[0]), x_edges[-1], latitude_at(y_edges[-1]))
    data = prepare(folder, coverage)
    tiles = {(x, row): [] for x in range(5) for row in range(5)}
    cells_in_coverage = data.pop('cells')
    version = hashlib.sha256(json.dumps([coverage, cells_in_coverage]).encode()).hexdigest()[:12]
    for cell in cells_in_coverage:
        boundary = h3.cell_to_boundary(cell['id'])
        longitudes = [position[1] for position in boundary]
        ys = [mercator_y(position[0]) for position in boundary]
        columns = [i for i in range(5) if min(longitudes) < x_edges[i + 1] and max(longitudes) > x_edges[i]]
        rows = [i for i in range(5) if min(ys) < y_edges[i + 1] and max(ys) > y_edges[i]]
        for x in columns:
            for row in rows:
                tiles[x, row].append(cell)

    central = {cell['id']: cell for x in range(1, 4) for row in range(1, 4) for cell in tiles[x, row]}
    paired = [cell for cell in central.values() if cell['A1'] is not None and cell['A2'] is not None]
    data.update({
        'blockSchema': 1,
        'cacheKey': f'modis-2024-193-{version}',
        'colorBreaks': {key: quantiles([cell[key] for cell in paired], n=3, method='inclusive')
                        for key in INPUTS},
        'blocks': {},
    })
    tile_dir = destination / 'blocks' / data['cacheKey']
    tile_dir.mkdir(parents=True, exist_ok=True)
    for (x, row), cells in tiles.items():
        key = f'{x}-{row}'
        relative = f'blocks/{data["cacheKey"]}/{key}.json'
        payload = json.dumps({'id': key, 'cells': cells}, separators=(',', ':')) + '\n'
        (destination / relative).write_text(payload)
        data['blocks'][key] = {
            'url': relative,
            'bytes': len(payload.encode()),
            'bounds': {'west': x_edges[x], 'south': latitude_at(y_edges[row]),
                       'east': x_edges[x + 1], 'north': latitude_at(y_edges[row + 1])},
        }
    data['coverage'] = dict(zip(('west', 'south', 'east', 'north'), coverage, strict=True))
    manifest = destination / 'manifest.json'
    temporary = manifest.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(manifest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('geotiff_directory', type=Path)
    output = parser.add_mutually_exclusive_group()
    output.add_argument('--output', type=Path, help='Write a standalone JSON snapshot instead of blocks')
    output.add_argument('--blocks', type=Path, help='Write the extended study area as map blocks to this folder')
    arguments = parser.parse_args()
    if not arguments.output:
        destination = arguments.blocks or PROJECT / 'public/midwest/data'
        build_blocks(arguments.geotiff_directory, destination)
        return
    dataset = prepare(arguments.geotiff_directory)
    temporary = arguments.output.with_suffix('.tmp')
    temporary.write_text(json.dumps(dataset, ensure_ascii=False, separators=(',', ':')) + '\n')
    temporary.replace(arguments.output)


if __name__ == '__main__':
    main()
