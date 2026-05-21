import json
import os
import sys

import torch
from huggingface_hub import hf_hub_download
from transformers import AutoModelForMaskedLM, AutoTokenizer


def build_query_token_weight_vector(tokenizer, model_id: str):
    local_cached_path = hf_hub_download(repo_id=model_id, filename="query_token_weights.txt")
    vector = [0.0] * tokenizer.vocab_size

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


def encode_document(model, tokenizer, text: str, top_tokens: int, special_token_ids: list[int]):
    features = tokenizer([text], padding=True, truncation=True, return_tensors="pt", return_token_type_ids=False)
    output = model(**features).logits
    values, _ = torch.max(output * features["attention_mask"].unsqueeze(-1), dim=1)
    values = torch.log1p(torch.relu(values))
    values[:, special_token_ids] = 0

    row = values[0].detach()
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


def load_runtime(model_id: str):
    tokenizer = AutoTokenizer.from_pretrained(model_id)
    model = AutoModelForMaskedLM.from_pretrained(model_id)
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
    json.dump({
        "ok": True,
        "vocabularySize": tokenizer.vocab_size,
        "queryTokenWeightsLength": len(query_weights)
    }, sys.stdout)


def encode_documents(model_id: str, top_tokens: int, documents):
    tokenizer, model, special_token_ids = load_runtime(model_id)
    output_documents = []
    for document in documents:
        output_documents.append({
            "chunkId": document["chunkId"],
            "vector": encode_document(model, tokenizer, document["text"], top_tokens, special_token_ids)
        })

    json.dump({
        "query_token_weights": build_query_token_weight_vector(tokenizer, model_id),
        "documents": output_documents,
        "vocabularySize": tokenizer.vocab_size
    }, sys.stdout)


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as handle:
            payload = json.load(handle)
    else:
        payload = json.load(sys.stdin)
    action = payload["action"]
    model_id = payload["model_id"]
    if action == "download_only":
        download_only(model_id)
        return
    if action == "encode_documents":
        encode_documents(model_id, int(payload["top_tokens"]), payload["documents"])
        return
    raise SystemExit(f"unsupported action: {action}")


if __name__ == "__main__":
    main()
