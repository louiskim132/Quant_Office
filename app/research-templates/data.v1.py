"""data.v1 - emit a dataset manifest for the office's G-TIME and G-TARGET contracts.

Authored here and executed on the hosted route. Nothing in this file is run by the desktop office.

The only judgement this template makes is about availability: for each column it records how long
after a row's own timestamp the value is genuinely knowable. A feature with a positive lag is a
look-ahead, and saying so here is cheaper than discovering it in a backtest that already looked good.
"""
import hashlib, json, sys

SCHEMA_VERSION = 1
TEMPLATE_VERSION = "1.0.0"


def manifest(frame, spec):
    columns = []
    for name in frame.columns:
        role = spec["roles"][name]
        columns.append({
            "name": name,
            "dtype": spec["dtypes"][name],
            "role": role,
            # Declared in the frozen specification, never inferred from the data: inferring it from
            # the data is how a lag becomes whatever the data happens to support.
            "availableAfterSeconds": int(spec["availability"][name]),
            "group": spec["groups"][name],
        })
    return {
        "schemaVersion": SCHEMA_VERSION,
        "datasetId": spec["datasetId"],
        "sourceHash": hashlib.sha256(spec["sourceBytes"]).hexdigest(),
        "rows": int(len(frame)),
        "timezone": spec["timezone"],
        "timestampColumn": spec["timestampColumn"],
        "targetColumn": spec["targetColumn"],
        "firstTimestamp": spec["firstTimestamp"],
        "lastTimestamp": spec["lastTimestamp"],
        "columns": columns,
    }


if __name__ == "__main__":
    sys.stdout.write(json.dumps({"template": "data", "version": TEMPLATE_VERSION}))
