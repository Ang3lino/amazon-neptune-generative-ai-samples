"""Load air-routes into Neptune Analytics. Run: python seed_airports.py"""
import os, re
from concurrent.futures import ThreadPoolExecutor, as_completed
import boto3
from botocore.config import Config

GRAPH_ID = "g-46jp136r81"
REGION = "us-east-1"
WORKERS = 3

seed_file = os.path.join(
    os.path.dirname(__import__('graph_notebook.seed', fromlist=['x']).__file__),
    'queries', 'propertygraph', 'opencypher', 'airports', 'airports_full.txt'
)

with open(seed_file, encoding='utf-8') as f:
    content = f.read()

lines = content.split('\n')

# Parse variable-to-id mapping from node CREATEs: CREATE (a1:airport {id:'1',...})
var_map = {}
node_pattern = re.compile(r"^CREATE \((\w+):\w+ \{id:'([^']+)'")
for line in lines:
    m = node_pattern.match(line.strip())
    if m:
        var_map[m.group(1)] = m.group(2)

print(f"Parsed {len(var_map)} node variables")

# Parse edge lines: (a1)-[:route {id: '3749', dist: 809}]->(a3)
edge_pattern = re.compile(r"\((\w+)\)-\[:(\w+) \{([^}]+)\}\]->\((\w+)\)")
edge_queries = []
for line in lines:
    line = line.strip().rstrip(',')
    m = edge_pattern.search(line)
    if m:
        src_var, rel_type, props, dst_var = m.groups()
        src_id = var_map.get(src_var)
        dst_id = var_map.get(dst_var)
        if src_id and dst_id:
            edge_queries.append(
                f"MATCH (src {{id:'{src_id}'}}), (dst {{id:'{dst_id}'}}) CREATE (src)-[:{rel_type} {{{props}}}]->(dst)"
            )

print(f"Converted {len(edge_queries)} edges to MATCH-based queries")

cfg = Config(retries={"max_attempts": 10, "mode": "adaptive"})
client = boto3.client('neptune-graph', region_name=REGION, config=cfg)
errors = []

def run(stmt):
    client.execute_query(graphIdentifier=GRAPH_ID, queryString=stmt, language='OPEN_CYPHER')

with ThreadPoolExecutor(max_workers=WORKERS) as pool:
    futures = {pool.submit(run, s): i for i, s in enumerate(edge_queries)}
    done = 0
    for fut in as_completed(futures):
        done += 1
        if done % 2000 == 0:
            print(f"  {done}/{len(edge_queries)}")
        try:
            fut.result()
        except Exception as e:
            errors.append((futures[fut], str(e)))

print(f"Done. {len(edge_queries) - len(errors)} succeeded, {len(errors)} errors.")
if errors:
    for idx, err in errors[:3]:
        print(f"  [{idx}] {err[:200]}")
