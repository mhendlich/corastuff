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
    - "1.299,00 €"
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

    # Extract numeric chunk and normalize thousands/decimal separators.
    if not (match := re.search(r"[\d][\d\s.,]*", text)):
        return None, currency

    num = match.group(0).replace(" ", "").replace("\xa0", "")

    last_comma = num.rfind(",")
    last_dot = num.rfind(".")

    if last_comma != -1 and last_dot != -1:
        # Assume last separator is decimal; the other is thousands.
        if last_comma > last_dot:
            num = num.replace(".", "").replace(",", ".")
        else:
            num = num.replace(",", "")
    elif last_comma != -1:
        digits_after = len(num) - last_comma - 1
        if 1 <= digits_after <= 2:
            num = num.replace(".", "").replace(",", ".")
        else:
            num = num.replace(",", "")
    elif last_dot != -1:
        digits_after = len(num) - last_dot - 1
        if 1 <= digits_after <= 2:
            num = num.replace(",", "")
        else:
            num = num.replace(".", "")

    try:
        return float(num), currency
    except ValueError:
        return None, currency
