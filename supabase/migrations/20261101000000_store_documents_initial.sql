-- Surgical Store 8 document-store schema.
-- The existing FastAPI backend uses a trusted direct PostgreSQL connection.
-- Keep this table unavailable to anon/authenticated Data API roles.

CREATE TABLE IF NOT EXISTS public.store_documents (
  collection TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection, doc_id)
);

CREATE INDEX IF NOT EXISTS idx_store_documents_collection
  ON public.store_documents(collection);

CREATE INDEX IF NOT EXISTS idx_store_documents_doc_gin
  ON public.store_documents USING GIN (doc);

ALTER TABLE public.store_documents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.store_documents FROM PUBLIC, anon, authenticated;
