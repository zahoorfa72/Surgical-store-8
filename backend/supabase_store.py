import base64, json
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Optional
import asyncpg
from bson import Binary, ObjectId

SCHEMA = """
CREATE TABLE IF NOT EXISTS store_documents (
 collection TEXT NOT NULL, doc_id TEXT NOT NULL, doc JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY (collection, doc_id)
);
CREATE INDEX IF NOT EXISTS idx_store_documents_collection ON store_documents(collection);
CREATE INDEX IF NOT EXISTS idx_store_documents_doc_gin ON store_documents USING GIN (doc);
"""

def _encode(v):
    if isinstance(v,ObjectId): return {"__bson_objectid__":str(v)}
    if isinstance(v,Binary): return {"__bson_binary__":base64.b64encode(bytes(v)).decode()}
    if isinstance(v,datetime): return {"__bson_datetime__":v.isoformat()}
    if isinstance(v,date): return {"__bson_date__":v.isoformat()}
    if isinstance(v,Decimal): return float(v)
    if isinstance(v,dict): return {str(k):_encode(x) for k,x in v.items()}
    if isinstance(v,list): return [_encode(x) for x in v]
    return v

def _decode(v):
    if isinstance(v,dict):
        if set(v)=={"__bson_objectid__"}: return ObjectId(v["__bson_objectid__"])
        if set(v)=={"__bson_binary__"}: return Binary(base64.b64decode(v["__bson_binary__"]))
        if set(v)=={"__bson_datetime__"}: return datetime.fromisoformat(v["__bson_datetime__"])
        if set(v)=={"__bson_date__"}: return date.fromisoformat(v["__bson_date__"])
        return {k:_decode(x) for k,x in v.items()}
    if isinstance(v,list): return [_decode(x) for x in v]
    return v

def _cmp(v):
    if isinstance(v,datetime): return v.timestamp()
    if isinstance(v,date): return datetime(v.year,v.month,v.day).timestamp()
    return v

def _eq(a,b):
    if isinstance(a,ObjectId): a=str(a)
    if isinstance(b,ObjectId): b=str(b)
    if isinstance(a,(datetime,date)) and isinstance(b,(datetime,date)): return _cmp(a)==_cmp(b)
    return a==b

def _matches(doc,q):
    for k,want in (q or {}).items():
        got=doc.get(k)
        if isinstance(want,dict) and any(str(x).startswith("$") for x in want):
            for op,val in want.items():
                if op=="$ne" and _eq(got,val): return False
                if op=="$gt" and (got is None or _cmp(got)<=_cmp(val)): return False
                if op=="$gte" and (got is None or _cmp(got)<_cmp(val)): return False
                if op=="$lt" and (got is None or _cmp(got)>=_cmp(val)): return False
                if op=="$lte" and (got is None or _cmp(got)>_cmp(val)): return False
                if op=="$in" and not any(_eq(got,x) for x in val): return False
        elif not _eq(got,want): return False
    return True

def _apply(doc,upd,inserting=False):
    out=dict(doc)
    if inserting: out.update({k:_decode(_encode(v)) for k,v in upd.get("$setOnInsert",{}).items()})
    out.update({k:_decode(_encode(v)) for k,v in upd.get("$set",{}).items()})
    for k,v in upd.get("$inc",{}).items(): out[k]=(out.get(k,0) or 0)+v
    if not any(str(k).startswith("$") for k in upd): out=dict(upd)
    return out

class DocumentCursor:
    def __init__(self,store,name,query):
        self.store,self.name,self.query=store,name,query
        self.sort_key=None; self.sort_direction=1
    def sort(self,key,direction=1):
        self.sort_key,self.sort_direction=key,direction
        return self
    async def to_list(self,length):
        rows=await self.store._find(self.name,self.query)
        if self.sort_key:
            rows.sort(key=lambda x:_cmp(x.get(self.sort_key)) if x.get(self.sort_key) is not None else "", reverse=self.sort_direction<0)
        return rows if not length or length<0 else rows[:length]

class DocumentCollection:
    def __init__(self,store,name): self.store,self.name=store,name
    async def create_index(self,*args,**kwargs): return None
    def find(self,query=None): return DocumentCursor(self.store,self.name,query or {})
    async def find_one(self,query=None): 
        rows=await self.store._find(self.name,query or {})
        return rows[0] if rows else None
    async def insert_one(self,doc):
        item=dict(doc); item.setdefault("_id",ObjectId())
        await self.store._insert(self.name,item)
        return type("InsertOneResult",(),{"inserted_id":item["_id"]})()
    async def update_one(self,q,u,upsert=False): return await self.store._update_one(self.name,q,u,upsert)
    async def update_many(self,q,u): return await self.store._update_many(self.name,q,u)
    async def delete_many(self,q): return await self.store._delete_many(self.name,q)
    async def find_one_and_update(self,q,u,upsert=False,return_document=True): return await self.store._find_one_and_update(self.name,q,u,upsert)

class SupabaseDocumentDB:
    def __init__(self,dsn):
        self.dsn=dsn; self.pool=None
    def __getitem__(self,name): return DocumentCollection(self,name)
    async def connect(self):
        self.pool=await asyncpg.create_pool(self.dsn,min_size=1,max_size=10,command_timeout=30)
        async with self.pool.acquire() as c: await c.execute(SCHEMA)
    async def close(self):
        if self.pool: await self.pool.close(); self.pool=None
    async def _find(self,name,q):
        async with self.pool.acquire() as c:
            rows=await c.fetch("SELECT doc FROM store_documents WHERE collection=$1",name)
        return [x for x in (_decode(dict(r["doc"])) for r in rows) if _matches(x,q)]
    async def _insert(self,name,doc):
        async with self.pool.acquire() as c:
            await c.execute("INSERT INTO store_documents(collection,doc_id,doc,updated_at) VALUES($1,$2,$3::jsonb,NOW())",name,str(doc["_id"]),json.dumps(_encode(doc)))
    async def _replace(self,name,doc):
        async with self.pool.acquire() as c:
            await c.execute("UPDATE store_documents SET doc=$3::jsonb,updated_at=NOW() WHERE collection=$1 AND doc_id=$2",name,str(doc["_id"]),json.dumps(_encode(doc)))
    async def _update_one(self,name,q,u,upsert):
        rows=await self._find(name,q)
        if rows:
            await self._replace(name,_apply(rows[0],u))
            return type("UpdateResult",(),{"matched_count":1,"modified_count":1,"upserted_id":None})()
        if not upsert: return type("UpdateResult",(),{"matched_count":0,"modified_count":0,"upserted_id":None})()
        base={k:v for k,v in q.items() if not str(k).startswith("$") and not isinstance(v,dict)}
        base["_id"]=base.get("_id",ObjectId()); new=_apply(base,u,True)
        await self._insert(name,new)
        return type("UpdateResult",(),{"matched_count":0,"modified_count":0,"upserted_id":new["_id"]})()
    async def _update_many(self,name,q,u):
        rows=await self._find(name,q)
        for row in rows: await self._replace(name,_apply(row,u))
        return type("UpdateResult",(),{"matched_count":len(rows),"modified_count":len(rows)})()
    async def _delete_many(self,name,q):
        rows=await self._find(name,q); ids=[str(x["_id"]) for x in rows]
        if ids:
            async with self.pool.acquire() as c:
                await c.execute("DELETE FROM store_documents WHERE collection=$1 AND doc_id=ANY($2::text[])",name,ids)
        return type("DeleteResult",(),{"deleted_count":len(ids)})()
    async def _find_one_and_update(self,name,q,u,upsert):
        key=str(q.get("_id"))
        async with self.pool.acquire() as c:
            async with c.transaction():
                row=await c.fetchrow("SELECT doc FROM store_documents WHERE collection=$1 AND doc_id=$2 FOR UPDATE",name,key)
                if row:
                    old=_decode(dict(row["doc"])); new=_apply(old,u)
                    await c.execute("UPDATE store_documents SET doc=$3::jsonb,updated_at=NOW() WHERE collection=$1 AND doc_id=$2",name,key,json.dumps(_encode(new)))
                    return new
                if not upsert: return None
                new=_apply({"_id":q.get("_id",ObjectId())},u,True)
                await c.execute("INSERT INTO store_documents(collection,doc_id,doc,updated_at) VALUES($1,$2,$3::jsonb,NOW())",name,str(new["_id"]),json.dumps(_encode(new)))
                return new
