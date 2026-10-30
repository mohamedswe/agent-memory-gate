"""Local sentence embeddings for scripts/memory-tree.ts (--embedder python).

Reads a JSON list of strings on stdin, writes a JSON list of unit vectors on
stdout. Runs entirely on this machine; the model downloads once from
Hugging Face. Install: pip install sentence-transformers
"""
import json
import sys

from sentence_transformers import SentenceTransformer

model_name = sys.argv[1] if len(sys.argv) > 1 else "all-MiniLM-L6-v2"
texts = json.loads(sys.stdin.buffer.read().decode("utf-8"))
model = SentenceTransformer(f"sentence-transformers/{model_name}")
vectors = model.encode(texts, batch_size=32, normalize_embeddings=True, show_progress_bar=False)
sys.stdout.write(json.dumps(vectors.tolist()))
