import fs from "node:fs/promises";

const PROJECT_ID = process.env.FIRESTORE_PROJECT_ID || "dasanind-mes";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const OUT = process.argv[2] || "mes-firestore-backup.json";
const DB_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/%28default%29/documents`;

if (!ACCESS_TOKEN) {
  console.error("ACCESS_TOKEN is required");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${ACCESS_TOKEN}`,
  "Content-Type": "application/json",
};

const encPath = (path) => path.split("/").map(encodeURIComponent).join("/");

async function api(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const txt = await res.text();
  let body = {};
  try { body = txt ? JSON.parse(txt) : {}; } catch { body = { raw: txt }; }
  if (!res.ok) throw new Error(`${options.method || "GET"} ${url} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

function relativeDocPath(name) {
  const marker = "/documents/";
  const i = name.indexOf(marker);
  if (i < 0) throw new Error(`Unexpected document name: ${name}`);
  return name.slice(i + marker.length);
}

async function listCollectionIds(parentDocPath = "") {
  const url = parentDocPath
    ? `${DB_BASE}/${encPath(parentDocPath)}:listCollectionIds`
    : `${DB_BASE}:listCollectionIds`;
  const ids = [];
  let pageToken = "";

  do {
    const body = await api(url, {
      method: "POST",
      body: JSON.stringify({ pageSize: 1000, ...(pageToken ? { pageToken } : {}) }),
    });
    ids.push(...(body.collectionIds || []));
    pageToken = body.nextPageToken || "";
  } while (pageToken);

  return [...new Set(ids)].sort();
}

async function listDocuments(parentDocPath, collectionId) {
  const base = parentDocPath
    ? `${DB_BASE}/${encPath(parentDocPath)}/${encodeURIComponent(collectionId)}`
    : `${DB_BASE}/${encodeURIComponent(collectionId)}`;

  const docs = [];
  let pageToken = "";

  do {
    const q = new URLSearchParams({ pageSize: "300", showMissing: "true" });
    if (pageToken) q.set("pageToken", pageToken);
    const body = await api(`${base}?${q.toString()}`);
    docs.push(...(body.documents || []));
    pageToken = body.nextPageToken || "";
  } while (pageToken);

  docs.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return docs;
}

const collections = [];
let documentCount = 0;

async function walkCollections(parentDocPath = "") {
  const ids = await listCollectionIds(parentDocPath);

  for (const id of ids) {
    const docs = await listDocuments(parentDocPath, id);
    const collectionPath = parentDocPath ? `${parentDocPath}/${id}` : id;
    collections.push({
      collectionPath,
      documentCount: docs.length,
      documents: docs,
    });
    documentCount += docs.length;

    for (const doc of docs) {
      await walkCollections(relativeDocPath(doc.name));
    }
  }
}

await walkCollections();

collections.sort((a, b) => a.collectionPath.localeCompare(b.collectionPath));

const topLevelCollections = collections
  .filter((c) => !c.collectionPath.includes("/"))
  .map((c) => c.collectionPath)
  .sort();

const output = {
  format: "dasan-mes-firestore-full-backup-v1",
  source: {
    projectId: PROJECT_ID,
    database: "(default)",
  },
  createdAt: new Date().toISOString(),
  protection: {
    encryptedByWorkflow: true,
    encryptionScheme: "AES-256-CBC/PBKDF2-200000 + RSA-3072-OAEP-SHA256 wrapped passphrase",
  },
  summary: {
    topLevelCollections,
    collectionCount: collections.length,
    documentCount,
  },
  collections,
};

await fs.writeFile(OUT, JSON.stringify(output, null, 2) + "\n", "utf8");
console.log(JSON.stringify(output.summary));
