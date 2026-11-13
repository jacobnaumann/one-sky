#!/usr/bin/env python3
"""Generate src/lib/tzdata.ts from the IANA time-zone database.

Usage:  python scripts/gen-tz.py

Sources, in order of preference:
  1. the `tzdata` PyPI package (pip install tzdata) - zone1970.tab, zone.tab,
     iso3166.tab and tzdata.zi (which carries the `backward` links as "L" lines);
  2. a download from https://data.iana.org/time-zones/tzdb/ (cached in
     scripts/.tzcache/), using the plain `backward` file for links.

Output (one Place per zone):
  - every row of zone1970.tab (country code = first code on the line);
  - plus every row of zone.tab whose zone is NOT in zone1970.tab. Those are the
    per-country zones that zone1970 merged into a neighbour (Europe/Amsterdam ->
    Europe/Brussels, Asia/Kuwait -> Asia/Riyadh ...). They keep their own
    coordinates and country so people there appear where they actually are.
  - an alias map for every remaining link name (Asia/Calcutta -> Asia/Kolkata,
    US/Pacific -> America/Los_Angeles ...) that points at a zone we have a
    Place for.

This script runs at development time only; the app itself never touches the
network for this data.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "src", "lib", "tzdata.ts"))
CACHE = os.path.join(HERE, ".tzcache")
BASE_URL = "https://data.iana.org/time-zones/tzdb/"

# Friendlier English country names than iso3166.tab's.
COUNTRY_NAMES = {
    "AS": "American Samoa",
    "CD": "DR Congo",
    "CG": "Republic of the Congo",
    "CZ": "Czechia",
    "GB": "United Kingdom",
    "GS": "South Georgia",
    "KN": "St Kitts & Nevis",
    "KP": "North Korea",
    "KR": "South Korea",
    "MF": "Saint Martin",
    "MM": "Myanmar",
    "ST": "São Tomé & Príncipe",
    "SX": "Sint Maarten",
    "SZ": "Eswatini",
    "TC": "Turks & Caicos Islands",
    "VG": "British Virgin Islands",
    "VI": "US Virgin Islands",
    "WS": "Samoa",
}

# City names where the zone's last segment is a poor label. Where a zone is
# named after a country or island, the tz coordinates are those of its main
# town, so that town is used. Everything else is "last segment, _ -> space".
CITY_NAMES = {
    "Africa/Asmara": "Asmara",
    "Africa/Ceuta": "Ceuta",
    "Africa/El_Aaiun": "Laayoune",
    "Africa/Lome": "Lomé",
    "Africa/Ndjamena": "N'Djamena",
    "Africa/Sao_Tome": "São Tomé",
    "America/Anguilla": "The Valley",
    "America/Antigua": "St. John's",
    "America/Araguaina": "Araguaína",
    "America/Argentina/Cordoba": "Córdoba",
    "America/Argentina/Rio_Gallegos": "Río Gallegos",
    "America/Argentina/Tucuman": "Tucumán",
    "America/Aruba": "Oranjestad",
    "America/Asuncion": "Asunción",
    "America/Bahia": "Salvador",
    "America/Bahia_Banderas": "Bahía de Banderas",
    "America/Barbados": "Bridgetown",
    "America/Belem": "Belém",
    "America/Belize": "Belize City",
    "America/Bogota": "Bogotá",
    "America/Cancun": "Cancún",
    "America/Cayman": "George Town",
    "America/Ciudad_Juarez": "Ciudad Juárez",
    "America/Costa_Rica": "San José",
    "America/Cuiaba": "Cuiabá",
    "America/Curacao": "Willemstad",
    "America/Dominica": "Roseau",
    "America/Eirunepe": "Eirunepé",
    "America/El_Salvador": "San Salvador",
    "America/Grenada": "St. George's",
    "America/Guadeloupe": "Basse-Terre",
    "America/Guatemala": "Guatemala City",
    "America/Guyana": "Georgetown",
    "America/Jamaica": "Kingston",
    "America/Lower_Princes": "Philipsburg",
    "America/Maceio": "Maceió",
    "America/Martinique": "Fort-de-France",
    "America/Mazatlan": "Mazatlán",
    "America/Merida": "Mérida",
    "America/Miquelon": "Saint-Pierre",
    "America/Montserrat": "Plymouth",
    "America/Noronha": "Fernando de Noronha",
    "America/North_Dakota/Beulah": "Beulah",
    "America/North_Dakota/Center": "Center",
    "America/North_Dakota/New_Salem": "New Salem",
    "America/Panama": "Panama City",
    "America/Puerto_Rico": "San Juan",
    "America/Santarem": "Santarém",
    "America/Sao_Paulo": "São Paulo",
    "America/Scoresbysund": "Ittoqqortoormiit",
    "America/St_Barthelemy": "Gustavia",
    "America/St_Johns": "St. John's",
    "America/St_Kitts": "Basseterre",
    "America/St_Lucia": "Castries",
    "America/St_Thomas": "Charlotte Amalie",
    "America/St_Vincent": "Kingstown",
    "America/Thule": "Pituffik",
    "America/Tortola": "Road Town",
    "Antarctica/DumontDUrville": "Dumont d'Urville Station",
    "Antarctica/Casey": "Casey Station",
    "Antarctica/Davis": "Davis Station",
    "Antarctica/Macquarie": "Macquarie Island",
    "Antarctica/Mawson": "Mawson Station",
    "Antarctica/McMurdo": "McMurdo Station",
    "Antarctica/Palmer": "Palmer Station",
    "Antarctica/Rothera": "Rothera Station",
    "Antarctica/Syowa": "Syowa Station",
    "Antarctica/Troll": "Troll Station",
    "Antarctica/Vostok": "Vostok Station",
    "Asia/Bahrain": "Manama",
    "Asia/Brunei": "Bandar Seri Begawan",
    "Asia/Ho_Chi_Minh": "Ho Chi Minh City",
    "Asia/Hong_Kong": "Hong Kong",
    "Asia/Kolkata": "Kolkata",
    "Asia/Kuwait": "Kuwait City",
    "Asia/Qatar": "Doha",
    "Asia/Urumqi": "Ürümqi",
    "Asia/Yangon": "Yangon",
    "Atlantic/Azores": "Ponta Delgada",
    "Atlantic/Bermuda": "Hamilton",
    "Atlantic/Canary": "Las Palmas",
    "Atlantic/Cape_Verde": "Praia",
    "Atlantic/Faroe": "Tórshavn",
    "Atlantic/Madeira": "Funchal",
    "Atlantic/Reykjavik": "Reykjavík",
    "Atlantic/South_Georgia": "South Georgia",
    "Atlantic/St_Helena": "Jamestown",
    "Australia/Lindeman": "Lindeman Island",
    "Australia/Lord_Howe": "Lord Howe Island",
    "Europe/Andorra": "Andorra la Vella",
    "Europe/Busingen": "Büsingen",
    "Europe/Chisinau": "Chișinău",
    "Europe/Guernsey": "St Peter Port",
    "Europe/Isle_of_Man": "Douglas",
    "Europe/Jersey": "St Helier",
    "Europe/Malta": "Valletta",
    "Europe/Vatican": "Vatican City",
    "Europe/Zurich": "Zürich",
    "Indian/Antananarivo": "Antananarivo",
    "Indian/Chagos": "Chagos Archipelago",
    "Indian/Christmas": "Christmas Island",
    "Indian/Cocos": "Cocos Islands",
    "Indian/Comoro": "Moroni",
    "Indian/Kerguelen": "Port-aux-Français",
    "Indian/Mahe": "Victoria",
    "Indian/Maldives": "Malé",
    "Indian/Mauritius": "Port Louis",
    "Indian/Mayotte": "Mamoudzou",
    "Indian/Reunion": "Saint-Denis",
    "Pacific/Chatham": "Chatham Islands",
    "Pacific/Easter": "Easter Island",
    "Pacific/Efate": "Port Vila",
    "Pacific/Fiji": "Suva",
    "Pacific/Galapagos": "Galápagos",
    "Pacific/Gambier": "Gambier Islands",
    "Pacific/Guadalcanal": "Honiara",
    "Pacific/Guam": "Hagåtña",
    "Pacific/Kanton": "Kanton Island",
    "Pacific/Kiritimati": "Kiritimati",
    "Pacific/Marquesas": "Marquesas Islands",
    "Pacific/Midway": "Midway Atoll",
    "Pacific/Nauru": "Yaren",
    "Pacific/Niue": "Alofi",
    "Pacific/Norfolk": "Norfolk Island",
    "Pacific/Noumea": "Nouméa",
    "Pacific/Palau": "Ngerulmud",
    "Pacific/Pitcairn": "Adamstown",
    "Pacific/Rarotonga": "Avarua",
    "Pacific/Tahiti": "Papeete",
    "Pacific/Tongatapu": "Nukuʻalofa",
    "Pacific/Wake": "Wake Island",
    "Pacific/Wallis": "Mata-Utu",
}


def default_city(tz: str) -> str:
    """Must stay in step with defaultCity() in src/lib/tz.ts."""
    return tz.rsplit("/", 1)[-1].replace("_", " ")


def load_sources() -> tuple[dict[str, str], str]:
    """Return ({file name: text}, version label)."""
    names = ["zone1970.tab", "zone.tab", "iso3166.tab"]
    try:
        import tzdata  # type: ignore

        root = os.path.join(os.path.dirname(tzdata.__file__), "zoneinfo")
        files = {}
        for n in names + ["tzdata.zi"]:
            with open(os.path.join(root, n), encoding="utf-8") as f:
                files[n] = f.read()
        return files, str(getattr(tzdata, "IANA_VERSION", "unknown"))
    except Exception as err:  # not installed, or an unexpected layout
        print(f"tzdata package unavailable ({err}); downloading from IANA", file=sys.stderr)

    os.makedirs(CACHE, exist_ok=True)
    files = {}
    for n in names + ["backward", "version"]:
        path = os.path.join(CACHE, n)
        if not os.path.exists(path):
            with urllib.request.urlopen(BASE_URL + n, timeout=30) as r:
                data = r.read()
            with open(path, "wb") as f:
                f.write(data)
        with open(path, encoding="utf-8") as f:
            files[n] = f.read()
    return files, files.get("version", "unknown").strip()


def parse_iso6709(s: str) -> tuple[float, float]:
    """+DDMM+DDDMM or +DDMMSS+DDDMMSS -> decimal degrees rounded to 2 places."""
    m = re.fullmatch(r"([+-])(\d{2})(\d{2})(\d{2})?([+-])(\d{3})(\d{2})(\d{2})?", s)
    if not m:
        raise ValueError(f"bad ISO 6709 coordinate: {s!r}")
    lat = int(m[2]) + int(m[3]) / 60 + int(m[4] or 0) / 3600
    lon = int(m[6]) + int(m[7]) / 60 + int(m[8] or 0) / 3600
    if m[1] == "-":
        lat = -lat
    if m[5] == "-":
        lon = -lon
    return round(lat, 2), round(lon, 2)


def rows(text: str):
    for line in text.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        yield [c.strip() for c in line.split("\t")]


def parse_links(files: dict[str, str]) -> dict[str, str]:
    """link name -> target, from tzdata.zi ("L target name") or backward ("Link target name")."""
    links: dict[str, str] = {}
    text = files.get("tzdata.zi") or files.get("backward") or ""
    for line in text.splitlines():
        parts = line.split("#", 1)[0].split()
        if len(parts) >= 3 and parts[0] in ("L", "Link"):
            links[parts[2]] = parts[1]
    return links


def num(x: float) -> str:
    s = f"{x:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def main() -> None:
    files, version = load_sources()

    countries = {r[0]: COUNTRY_NAMES.get(r[0], r[1]) for r in rows(files["iso3166.tab"])}

    places: dict[str, tuple[float, float, str, str]] = {}
    for r in rows(files["zone1970.tab"]):
        ccs, coord, tz = r[0], r[1], r[2]
        lat, lon = parse_iso6709(coord)
        places[tz] = (lat, lon, CITY_NAMES.get(tz, ""), ccs.split(",")[0])
    n1970 = len(places)
    for r in rows(files["zone.tab"]):
        cc, coord, tz = r[0], r[1], r[2]
        if tz in places:
            continue
        lat, lon = parse_iso6709(coord)
        places[tz] = (lat, lon, CITY_NAMES.get(tz, ""), cc)

    unknown = sorted(set(CITY_NAMES) - set(places))
    if unknown:
        print(f"warning: CITY_NAMES entries with no zone: {unknown}", file=sys.stderr)
    for tz, p in places.items():
        if p[3] not in countries:
            raise SystemExit(f"no country name for {p[3]} ({tz})")

    links = parse_links(files)
    aliases: dict[str, str] = {}
    for name in sorted(links):
        if name in places:
            continue
        target, hops = links[name], 0
        while target not in places and target in links and hops < 5:
            target, hops = links[target], hops + 1
        if target in places:
            aliases[name] = target

    used = sorted({p[3] for p in places.values()})
    dump = lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":"))
    out = [
        "// GENERATED by scripts/gen-tz.py - do not edit by hand.",
        f"// Source: IANA tzdata {version} (zone1970.tab + zone.tab + iso3166.tab + backward links).",
        f"// {len(places)} places ({n1970} from zone1970.tab, {len(places) - n1970} more from zone.tab), {len(aliases)} aliases.",
        "",
        "/** [tz, lat, lon, city ('' = derive from the tz name), country code] */",
        "export type RawPlace = [string, number, number, string, string];",
        "",
        "export const TZ_VERSION = " + dump(version) + ";",
        "",
        "export const RAW_PLACES: RawPlace[] = [",
    ]
    for tz in sorted(places):
        lat, lon, city, cc = places[tz]
        out.append(f"[{dump(tz)},{num(lat)},{num(lon)},{dump(city)},{dump(cc)}],")
    out += ["];", "", "export const COUNTRIES: Record<string, string> = {"]
    out += [f"{cc}:{dump(countries[cc])}," for cc in used]
    out += ["};", "", "/** Old or link zone names -> a zone present in RAW_PLACES. */",
            "export const ALIASES: Record<string, string> = {"]
    out += [f"{dump(k)}:{dump(v)}," for k, v in sorted(aliases.items())]
    out += ["};", ""]

    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(out))
    print(f"wrote {OUT}: tzdata {version}, {len(places)} places, {len(aliases)} aliases")


if __name__ == "__main__":
    main()
