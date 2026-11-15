"""Read only the COG bytes needed by a MODIS block."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from functools import lru_cache
from hashlib import sha256
from io import BytesIO
import json
import math
import re
from pathlib import Path
from threading import Lock
from time import monotonic
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import transform_bounds
from rasterio.windows import from_bounds
from tifffile import TiffFile

CATALOG = 'https://planetarycomputer.microsoft.com/api/stac/v1/search'
SIGNING = 'https://planetarycomputer.microsoft.com/api/sas/v1/token/modiseuwest/modis-061-cogs'
STORAGE = 'https://modiseuwest.blob.core.windows.net/modis-061-cogs/'
MAX_RAW_BYTES = 24_000_000
MAX_CACHE_BYTES = 120_000_000
HEADER_BYTES = 32_768
SINUSOIDAL = CRS.from_proj4('+proj=sinu +R=6371007.181 +units=m +no_defs')
PRODUCTS = {
    'MOD11A2': ('A1', 'LST_Day_1km', 'QC_Day'),
    'MOD13Q1': ('A2', '250m_16_days_NDVI', '250m_16_days_pixel_reliability'),
}


def composite_window(start):
    jan1 = date(start.year, 1, 1)
    first = jan1 + timedelta(days=(start - jan1).days // 16 * 16)
    last = min(first + timedelta(days=15), date(start.year, 12, 31))
    return first, last


def composite_bands(first, last):
    second = first + timedelta(days=8)
    return {
        *(('MOD11A2', day.strftime('A%Y%j')) for day in (first, second) if day <= last),
        ('MOD13Q1', first.strftime('A%Y%j')),
    }


def retrieve(url, limit, byte_range=None, canceled=None):
    headers = {}
    if byte_range:
        start, size = byte_range
        headers['Range'] = f'bytes={start}-{start + size - 1}'
    try:
        with urlopen(Request(url, headers=headers), timeout=8) as response:
            if byte_range:
                match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)',
                                     response.headers.get('Content-Range', ''))
                if response.status != 206 or not match:
                    raise ValueError('The archive did not return the requested byte range.')
                first, last, total = map(int, match.groups())
                if first != start or last != min(start + size, total) - 1:
                    raise ValueError('The archive returned a mismatched byte range.')
                limit = last - first + 1
            data = bytearray()
            while len(data) <= limit:
                if canceled is not None and canceled.is_set():
                    raise ValueError('Download canceled.')
                chunk = response.read(min(65_536, limit + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
    except OSError:
        raise ValueError('The MODIS archive could not be reached. Try again.') from None
    if len(data) > limit or (byte_range and len(data) != limit):
        raise ValueError('The archive returned an unexpected number of bytes.')
    return bytes(data)


class Archive:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = Lock()
        self.token = ''
        self.token_until = 0

    def signed_url(self, href):
        if not href.startswith(STORAGE) or '?' in href or '#' in href:
            raise ValueError('Unexpected MODIS archive source.')
        with self.lock:
            if monotonic() >= self.token_until:
                self.token = json.loads(retrieve(SIGNING, 30_000))['token']
                self.token_until = monotonic() + 600
            return href + '?' + self.token

    def cache_path(self, href, start, size):
        return self.directory / (sha256(f'{href}:{start}:{size}'.encode()).hexdigest() + '.bin')

    def cached(self, href, start, size):
        return self.cache_path(href, start, size).is_file()

    def read(self, href, start, size, allow_fetch=True, canceled=None):
        path = self.cache_path(href, start, size)
        if path.is_file():
            data = path.read_bytes()
            path.touch()
            return data
        if not allow_fetch:
            raise ValueError('The archive cache changed. Request another update.')
        if canceled is not None and canceled.is_set():
            raise ValueError('Download canceled.')
        data = retrieve(self.signed_url(href), size, (start, size), canceled)
        with self.lock:
            if not path.exists():
                path.write_bytes(data)
        return data

    def trim(self):
        with self.lock:
            files = sorted(self.directory.glob('*.bin'), key=lambda path: path.stat().st_mtime)
            size = sum(path.stat().st_size for path in files)
            for path in files:
                if size <= MAX_CACHE_BYTES:
                    break
                size -= path.stat().st_size
                path.unlink()

    @lru_cache(maxsize=96)
    def catalog(self, bounds, first, last):
        query = urlencode({
            'collections': 'modis-11A2-061,modis-13Q1-061',
            'bbox': ','.join(map(str, bounds)),
            'datetime': f'{first}T00:00:00Z/{last}T23:59:59Z',
            'limit': 80,
        })
        return json.loads(retrieve(f'{CATALOG}?{query}', 1_000_000))['features']

    def plan(self, bounds, start, canceled):
        first, last = composite_window(start)
        wanted = composite_bands(first, last)
        dates_by_tile = {}
        assets = []
        for feature in self.catalog(bounds, first, last):
            product, day, tile, *_ = feature['id'].split('.')
            if (product, day) not in wanted:
                continue
            key, *bands = PRODUCTS[product]
            if not all(band in feature['assets'] for band in bands):
                continue
            dates = dates_by_tile.setdefault(tile, {'A1': [], 'A2': []})[key]
            if day in dates:
                continue
            dates.append(day)
            assets.extend((feature['id'], band, feature['assets'][band]['href']) for band in bands)
        if len(assets) * HEADER_BYTES > 1_000_000:
            raise ValueError('This block has too many source rasters to plan safely.')
        projected = transform_bounds('EPSG:4326', SINUSOIDAL, *bounds, densify_pts=41)
        with ThreadPoolExecutor(max_workers=6) as pool:
            sources = list(pool.map(lambda asset: self.band_plan(asset, projected, canceled), assets))
        ranges = [(source[2], start, size) for source in sources for start, size in source[4]]
        missing = sum(size for href, start, size in set(ranges) if not self.cached(href, start, size))
        if missing > MAX_RAW_BYTES:
            raise ValueError('This map block exceeds the 24 MB source-download limit.')
        return dates_by_tile, sources, missing

    def band_plan(self, asset, projected, canceled):
        item, band, href = asset
        header = self.read(href, 0, HEADER_BYTES, canceled=canceled)
        with TiffFile(BytesIO(header)) as tiff:
            page = tiff.pages[0]
            if not page.is_tiled:
                raise ValueError('This MODIS archive asset does not support tiled reads.')
            sx, sy, _ = page.tags['ModelPixelScaleTag'].value
            i, j, _, x, y, _ = page.tags['ModelTiepointTag'].value
            grid = from_origin(x - i * sx, y + j * sy, sx, sy)
            window = from_bounds(*projected, grid)
            w, h = page.tilewidth, page.tilelength
            across = math.ceil(page.shape[1] / w)
            cols = range(max(0, math.floor(window.col_off / w)),
                         min(across, math.ceil((window.col_off + window.width) / w)))
            rows = range(max(0, math.floor(window.row_off / h)),
                         min(math.ceil(page.shape[0] / h), math.ceil((window.row_off + window.height) / h)))
            blocks = []
            for r in rows:
                for c in cols:
                    offset = page.dataoffsets[r * across + c]
                    size = page.databytecounts[r * across + c]
                    if size and offset + size > len(header):
                        blocks.append((offset, size))
        return item, band, href, header, blocks

    def materialize(self, sources, directory, approved_bytes, canceled):
        ranges = {(href, start, size) for _, _, href, _, blocks in sources for start, size in blocks}
        missing = sum(size for href, start, size in ranges if not self.cached(href, start, size))
        if missing > min(approved_bytes, MAX_RAW_BYTES):
            raise ValueError('The source estimate changed. Request another update before downloading.')
        with ThreadPoolExecutor(max_workers=6) as pool:
            for _ in pool.map(lambda tile: self.read(*tile, canceled=canceled), ranges):
                pass
        for item, band, href, header, blocks in sources:
            with (directory / f'{item}_{band}.tif').open('wb') as raster:
                raster.write(header)
                for start, size in blocks:
                    raster.seek(start)
                    raster.write(self.read(href, start, size, allow_fetch=False))
        self.trim()
