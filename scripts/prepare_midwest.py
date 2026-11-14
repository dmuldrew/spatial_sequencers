"""Crop Terra MODIS GeoTIFF bands to the study box and prepare H3 cell means.

Usage: python3 scripts/prepare_midwest.py path/to/geotiffs
Requires rasterio, numpy and h3 (v4). See README for source asset names.
"""
import argparse
import json
import math
from pathlib import Path

import h3
import numpy as np
import rasterio
from rasterio.warp import transform, transform_bounds
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


def temperature(folder, tile, bounds, source_items):
    parts = [
        paired_bands(folder, 'MOD11A2', date, tile, 'LST_Day_1km', 'QC_Day', bounds, source_items)
        for date in TEMPERATURE_DATES
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


def vegetation(folder, tile, bounds, source_items):
    raw, quality, grid, crs = paired_bands(
        folder, 'MOD13Q1', VEGETATION_DATE, tile, '250m_16_days_NDVI',
        '250m_16_days_pixel_reliability', bounds, source_items,
    )
    # Reliability class 0 identifies good observations.
    valid = (raw >= -2000) & (raw <= 10000) & (quality == 0)
    return np.where(valid, raw * 0.0001, np.nan), grid, crs


def accumulate(totals, raster, grid, crs, bounds, resolution):
    west, south, east, north = bounds
    for first_row in range(0, raster.shape[0], 64):
        rows, columns = np.nonzero(np.isfinite(raster[first_row:first_row + 64]))
        rows += first_row
        if not len(rows):
            continue
        xs, ys = grid * (columns + 0.5, rows + 0.5)
        longitudes, latitudes = transform(crs, 'EPSG:4326', xs, ys)
        for lat, lon, value in zip(latitudes, longitudes, raster[rows, columns]):
            if south <= lat <= north and west <= lon <= east:
                cell = h3.latlng_to_cell(lat, lon, resolution)
                total, count = totals.get(cell, (0.0, 0))
                totals[cell] = total + float(value), count + 1


def prepare(folder):
    bounds = study_bounds()
    coarsest_pixel = max(item['resolutionMeters'] for item in INPUTS.values())
    resolution = max(index for index in range(11)
                     if h3.average_hexagon_area(index, 'm^2') >= coarsest_pixel ** 2)
    source_items = set()
    observations = {'A1': {}, 'A2': {}}
    for key, read in (('A1', temperature), ('A2', vegetation)):
        for tile in TILES:
            raster, grid, crs = read(folder, tile, bounds, source_items)
            accumulate(observations[key], raster, grid, crs, bounds, resolution)
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
    arguments = parser.parse_args()
    dataset = prepare(arguments.geotiff_directory)
    temporary = arguments.output.with_suffix('.tmp')
    temporary.write_text(json.dumps(dataset, ensure_ascii=False, separators=(',', ':')) + '\n')
    temporary.replace(arguments.output)


if __name__ == '__main__':
    main()
