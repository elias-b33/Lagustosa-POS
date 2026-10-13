"""Validate a training journal against the unmodified Skatteverket XSD.

Usage: python scripts/validate-journal-xml.py journal.xml
Reads stdin when the argument is '-'. No network or external XML entities.
This validates structure and data types, not legal compliance or certification.
"""
from pathlib import Path
import sys

from lxml import etree

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "vendor/skatteverket/xmls/instans/utredningsstod/2021-12-08/ExportAvDataFranJournalminneEnligtSKVFS202116-2021-12-08.xsd"


def main():
    if len(sys.argv) != 2:
        raise ValueError("Pass an XML filename or '-' for stdin")
    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)
    validator = etree.XMLSchema(etree.parse(str(SCHEMA), parser))
    data = sys.stdin.buffer.read() if sys.argv[1] == "-" else Path(sys.argv[1]).read_bytes()
    document = etree.fromstring(data, parser)
    if document.getroottree().docinfo.doctype:
        raise ValueError("DOCTYPE is not permitted in journal exports")
    validator.assertValid(document)
    print("Valid against Skatteverket XSD (structure only; training export)")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, etree.Error) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
