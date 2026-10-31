# Supabase project configuration

## Surgical Store 8
- Project name: Surgical Store 8
- Project reference: `vrfswiegggobqkdosewm`
- Region: `ap-south-1` (Mumbai)
- Project URL: `https://vrfswiegggobqkdosewm.supabase.co`

## Security
Project references and project URLs identify the Supabase project; they are not database credentials.
Never commit database passwords, connection strings containing passwords, Supabase secret/service-role keys, JWT signing secrets, SMTP passwords, or personal access tokens.
Use GitHub Actions Secrets or the deployment platform's secret manager for private credentials.

## Backend connection note
The current repository backend is FastAPI and connects directly to Supabase PostgreSQL using `SUPABASE_DB_URL`.
That connection string must remain server-side. It must never be included in the Expo app or a public environment file.
Supabase hosts the PostgreSQL database; it does not run this Python FastAPI server. A complete Supabase-only hosted API migration requires porting the FastAPI routes and business logic to Supabase Edge Functions before the FastAPI service can be retired.
