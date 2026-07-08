"""Read the product list from a Google Sheet published as CSV.

Publish the sheet: File -> Share -> Publish to web -> CSV, then set the
resulting link as SHEET_CSV_URL.

Expected columns (header names are matched case-insensitively):
  - name  (or the first column)
  - price (or the second column)
Extra columns are ignored.
"""

import csv
import io
from dataclasses import dataclass

import requests


@dataclass
class Product:
    name: str
    price: str

    @property
    def key(self) -> str:
        return self.name.strip().lower()


def fetch_products(csv_url: str) -> list[Product]:
    resp = requests.get(csv_url, timeout=30)
    resp.raise_for_status()
    resp.encoding = "utf-8"
    reader = csv.reader(io.StringIO(resp.text))
    rows = [row for row in reader if any(cell.strip() for cell in row)]
    if not rows:
        return []

    header = [cell.strip().lower() for cell in rows[0]]
    name_idx, price_idx = 0, 1
    has_header = False
    for i, cell in enumerate(header):
        if cell in ("name", "product", "product name", "نام", "محصول"):
            name_idx, has_header = i, True
        if cell in ("price", "قیمت"):
            price_idx, has_header = i, True

    data_rows = rows[1:] if has_header else rows
    products = []
    for row in data_rows:
        if len(row) <= max(name_idx, price_idx):
            continue
        name = row[name_idx].strip()
        price = row[price_idx].strip()
        if name:
            products.append(Product(name=name, price=price))
    return products
