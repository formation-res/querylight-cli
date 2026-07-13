import json
import os
import sys

import torch
from huggingface_hub import hf_hub_download
from transformers import AutoModelForMaskedLM, AutoTokenizer


def _load_query_weights_file(model_id: str, filename: str):
    try:
        return hf_hub_download(repo_id=model_id, filename=filename)
    except Exception:
        return None


def build_query_token_weight_vector(tokenizer, model_id: str):
    vector = [0.0] * tokenizer.vocab_size
    local_cached_path = _load_query_weights_file(model_id, "query_token_weights.txt")

    if local_cached_path is not None:
        with open(local_cached_path, encoding="utf-8") as handle:
            for line in handle:
                line = line.rstrip("\n")
                if not line:
                    continue
                token, weight = line.split("\t", 1)
                token_id = tokenizer._convert_token_to_id_with_added_voc(token)
                if token_id is not None and token_id >= 0:
                    vector[token_id] = float(weight)
        return vector

    local_cached_path = _load_query_weights_file(model_id, "idf.json")
    if local_cached_path is not None:
        with open(local_cached_path, encoding="utf-8") as handle:
            idf = json.load(handle)
        for token, weight in idf.items():
            token_id = tokenizer._convert_token_to_id_with_added_voc(token)
            if token_id is not None and token_id >= 0:
                vector[token_id] = float(weight)
        return vector

    raise FileNotFoundError(f"missing query token weights for {model_id}: expected query_token_weights.txt or idf.json")

    return vector


def sparse_vector_from_row(row, top_tokens: int):
    nonzero = torch.nonzero(row > 0, as_tuple=True)[0]
    if len(nonzero) == 0:
        return {}

    if top_tokens > 0 and len(nonzero) > top_tokens:
        candidate_weights = row[nonzero]
        top_indices = torch.topk(candidate_weights, k=top_tokens).indices
        nonzero = nonzero[top_indices]

    vector = {}
    for token_id in nonzero.tolist():
        weight = float(row[token_id])
        if weight > 0:
            vector[str(token_id)] = weight
    return vector


def normalize_text(value):
    if isinstance(value, str):
        text = value
    elif value is None:
        text = ""
    elif isinstance(value, (bytes, bytearray)):
        text = value.decode("utf-8", errors="replace")
    else:
        try:
            text = json.dumps(value, ensure_ascii=False, default=str)
        except TypeError:
            text = str(value)
    return text.replace("\x00", " ")


def encode_document_batch(model, tokenizer, texts: list[str], top_tokens: int, special_token_ids: list[int]):
    features = tokenizer(texts, padding=True, truncation=True, return_tensors="pt", return_token_type_ids=False)
    with torch.no_grad():
        output = model(**features).logits
    values, _ = torch.max(output * features["attention_mask"].unsqueeze(-1), dim=1)
    values = torch.log1p(torch.relu(values))
    values[:, special_token_ids] = 0

    return [sparse_vector_from_row(row.detach(), top_tokens) for row in values]


def load_runtime(model_id: str):
    tokenizer = AutoTokenizer.from_pretrained(model_id)
    model = AutoModelForMaskedLM.from_pretrained(model_id)
    model.eval()
    special_token_ids = [
        tokenizer.vocab[token]
        for value in tokenizer.special_tokens_map.values()
        for token in (value if isinstance(value, list) else [value])
        if token in tokenizer.vocab
    ]
    return tokenizer, model, special_token_ids


def download_only(model_id: str):
    tokenizer, _, _ = load_runtime(model_id)
    query_weights = build_query_token_weight_vector(tokenizer, model_id)
    return {
        "ok": True,
        "vocabularySize": tokenizer.vocab_size,
        "queryTokenWeightsLength": len(query_weights)
    }


def error_summary(error: Exception) -> str:
    return f"{type(error).__name__}: {error}"


def encode_documents(model_id: str, top_tokens: int, batch_size: int, documents):
    tokenizer, model, special_token_ids = load_runtime(model_id)
    output_documents = []
    skipped_documents = []
    batch_size = max(1, batch_size)
    normalized_documents = [
        {
            "chunkId": document["chunkId"],
            "text": normalize_text(document.get("text")),
        }
        for document in documents
    ]
    for offset in range(0, len(documents), batch_size):
        batch = normalized_documents[offset:offset + batch_size]
        try:
            vectors = encode_document_batch(
                model,
                tokenizer,
                [document["text"] for document in batch],
                top_tokens,
                special_token_ids,
            )
            for document, vector in zip(batch, vectors):
                output_documents.append({
                    "chunkId": document["chunkId"],
                    "vector": vector
                })
        except Exception:
            for document in batch:
                try:
                    vector = encode_document_batch(
                        model,
                        tokenizer,
                        [document["text"]],
                        top_tokens,
                        special_token_ids,
                    )[0]
                except Exception as document_error:
                    skipped_documents.append({
                        "chunkId": document["chunkId"],
                        "error": error_summary(document_error),
                    })
                    output_documents.append({
                        "chunkId": document["chunkId"],
                        "vector": {}
                    })
                    continue
                output_documents.append({
                    "chunkId": document["chunkId"],
                    "vector": vector
                })

    if normalized_documents and len(skipped_documents) == len(normalized_documents):
        raise RuntimeError(
            f"sparse encoding failed for all {len(normalized_documents)} documents; "
            f"first error: {skipped_documents[0]['error']}"
        )

    return {
        "query_token_weights": build_query_token_weight_vector(tokenizer, model_id),
        "documents": output_documents,
        "vocabularySize": tokenizer.vocab_size,
        "skipped_documents": skipped_documents
    }


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as handle:
            payload = json.load(handle)
    else:
        payload = json.load(sys.stdin)
    action = payload["action"]
    model_id = payload["model_id"]
    if action == "download_only":
        output = download_only(model_id)
    elif action == "encode_documents":
        output = encode_documents(model_id, int(payload["top_tokens"]), int(payload.get("batch_size", 16)), payload["documents"])
    else:
        raise SystemExit(f"unsupported action: {action}")

    output_path = payload.get("output_path")
    if output_path:
        with open(output_path, "w", encoding="utf-8") as handle:
            json.dump(output, handle)
    else:
        json.dump(output, sys.stdout)


if __name__ == "__main__":
    main()
