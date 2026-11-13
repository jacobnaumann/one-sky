// Public client configuration. The anon key is public by design: every table has row level
// security and all writes go through rate-limited database functions.
// Never put the service-role key or the database password here.

export const SUPABASE_URL = 'https://evktxfawnualbbmoujip.supabase.co';

export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV2a3R4ZmF3bnVhbGJibW91amlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ1NDczNTksImV4cCI6MjExMDEyMzM1OX0.-kjLgzQzymk16QOM8WcEZs8VZQPI4LqLAsD64rWPDYo';
