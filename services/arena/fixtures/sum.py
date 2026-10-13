import json
import sys

print(json.dumps(sum(json.load(sys.stdin))))
