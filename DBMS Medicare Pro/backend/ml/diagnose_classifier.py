import sys
import os
import csv
import json
import re
import math

# Simple list of English stopwords to filter out noise
STOPWORDS = {"and", "or", "the", "a", "an", "of", "with", "has", "complains", "patient", "suffering", "from", "in", "to", "for", "is", "at", "on", "was"}

def preprocess(text):
    """
    Cleans, tokenizes, and removes stopwords from input text.
    """
    text = text.lower()
    # Replace non-alphanumeric with spaces
    text = re.sub(r'[^a-z0-9\s]', ' ', text)
    tokens = text.split()
    # Filter stopwords and keep words with length > 1
    return [t for t in tokens if t not in STOPWORDS and len(t) > 1]

def calculate_tfidf(docs, query_tokens):
    """
    Computes TF-IDF vectors for a list of documents and a query.
    Returns the index of the document with the highest Cosine Similarity.
    """
    # 1. Build Vocabulary
    vocab = set()
    doc_tokens_list = []
    for doc in docs:
        tokens = preprocess(doc)
        doc_tokens_list.append(tokens)
        vocab.update(tokens)
    
    vocab = list(vocab)
    vocab_idx = {word: idx for idx, word in enumerate(vocab)}
    
    N = len(docs)
    
    # 2. Compute Document Frequency (DF) for IDF
    df = {}
    for tokens in doc_tokens_list:
        seen = set(tokens)
        for word in seen:
            df[word] = df.get(word, 0) + 1
            
    # 3. Compute IDF
    idf = {}
    for word in vocab:
        # Standard smoothed IDF formula
        idf[word] = math.log(1 + N / df[word]) + 1.0

    # 4. Vectorize Documents
    doc_vectors = []
    for tokens in doc_tokens_list:
        vector = [0.0] * len(vocab)
        # Compute TF (term frequency)
        tf = {}
        for token in tokens:
            tf[token] = tf.get(token, 0) + 1
        
        # Compute TF-IDF
        for token, count in tf.items():
            if token in vocab_idx:
                vector[vocab_idx[token]] = (count / len(tokens)) * idf[token]
        doc_vectors.append(vector)

    # 5. Vectorize Query
    query_vector = [0.0] * len(vocab)
    query_tf = {}
    for token in query_tokens:
        query_tf[token] = query_tf.get(token, 0) + 1
    
    for token, count in query_tf.items():
        if token in vocab_idx:
            query_vector[vocab_idx[token]] = (count / len(query_tokens)) * idf[token]

    # 6. Calculate Cosine Similarity
    def cosine_similarity(v1, v2):
        dot_product = sum(x * y for x, y in zip(v1, v2))
        magnitude_v1 = math.sqrt(sum(x * x for x in v1))
        magnitude_v2 = math.sqrt(sum(x * x for x in v2))
        if magnitude_v1 == 0 or magnitude_v2 == 0:
            return 0.0
        return dot_product / (magnitude_v1 * magnitude_v2)

    best_idx = 0
    best_sim = -1.0
    for idx, doc_vec in enumerate(doc_vectors):
        sim = cosine_similarity(doc_vec, query_vector)
        if sim > best_sim:
            best_sim = sim
            best_idx = idx
            
    return best_idx, best_sim

def main():
    if len(sys.argv) < 3 or sys.argv[1] != '--predict':
        print(json.dumps({"error": "Usage: python diagnose_classifier.py --predict 'symptoms text'"}))
        sys.exit(1)

    symptoms_query = sys.argv[2]
    query_tokens = preprocess(symptoms_query)
    
    if not query_tokens:
        # Fallback if query contains only stopwords/symbols
        print(json.dumps({"diagnosis": "General Medical Examination", "icd10": "Z00.00"}))
        sys.exit(0)

    # Resolve CSV filepath
    script_dir = os.path.dirname(os.path.abspath(__file__))
    csv_path = os.path.join(script_dir, 'datasets', 'symptoms_icd10.csv')
    
    if not os.path.exists(csv_path):
        print(json.dumps({"error": f"Dataset file not found at {csv_path}"}))
        sys.exit(1)

    docs = []
    diagnoses = []
    icd10_codes = []

    # Read the dataset
    with open(csv_path, mode='r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            docs.append(row['symptoms'])
            diagnoses.append(row['diagnosis'])
            icd10_codes.append(row['icd10'])

    if not docs:
        print(json.dumps({"diagnosis": "General Medical Examination", "icd10": "Z00.00"}))
        sys.exit(0)

    # Find closest match
    best_idx, confidence = calculate_tfidf(docs, query_tokens)

    # Output structure
    output = {
        "diagnosis": diagnoses[best_idx],
        "icd10": icd10_codes[best_idx]
    }
    
    print(json.dumps(output))

if __name__ == '__main__':
    main()

