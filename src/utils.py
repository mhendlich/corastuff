"""Shared utilities for scrapers."""

import re

CURRENCY_MAP = {
    "€": "EUR",
    "eur": "EUR",
    "chf": "CHF",
    "fr.": "CHF",
    "$": "USD",
    "usd": "USD",
    "£": "GBP",
    "gbp": "GBP",
}


def parse_price(price_text: str | None) -> tuple[float | None, str | None]:
    """Parse price text into (amount, currency).

    Handles formats like:
    - "27,56 €"
    - "ab 139,60 €"
    - "19.95 CHF"
    """
    if not price_text:
        return None, None

    text = price_text.strip().lower()

    # Find currency
    currency = None
    for symbol, normalized in CURRENCY_MAP.items():
        if symbol in text:
            currency = normalized
            text = text.replace(symbol, "")
            break

    # Remove common prefixes
    text = re.sub(r"^(ab|from|uvp|statt)\s+", "", text.strip())

    # Extract number: handle both "27,56" and "27.56" formats
    if match := re.search(r"(\d+)[.,](\d+)", text):
        return float(f"{match.group(1)}.{match.group(2)}"), currency

    # Try integer
    if match := re.search(r"(\d+)", text):
        return float(match.group(1)), currency

    return None, currency
