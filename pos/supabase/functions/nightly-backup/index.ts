// Supabase Edge Function: nightly-backup
// Free DIY backup: dumps every table to JSON and stores it in the private
// Storage bucket "backups" as  YYYY/MM/DD.json . Runs nightly via pg_cron.
//
// Deploy:  supabase functions deploy nightly-backup --no-verify-jwt
// Setup:   Storage → New bucket → name "backups", Private.

import { createClient } from "npm:@supabase/supabase-js@2";
import { isServiceCall } from "../_shared/log.ts";

const TABLES = [
  "shops", "profiles", "profile_shops", "items",
  "cash_sessions", "sales", "sale_items", "egoal_exports", "receipt_counters",
  "event_logs", "api_logs",
];

Deno.serve(async (req) => {
  if (!isServiceCall(req)) return new Response("unauthorized", { status: 401 });
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
  const dump: Record<string, unknown> = { taken_at: new Date().toISOString(), tables: {} };

  for (const table of TABLES) {
    const rows: unknown[] = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      const { data, error } = await supabase.from(table).select("*").range(from, from + page - 1);
      if (error) return Response.json({ ok: false, table, error: error.message }, { status: 500 });
      rows.push(...(data ?? []));
      if (!data || data.length < page) break;
    }
    (dump.tables as Record<string, unknown>)[table] = rows;
  }

  const now = new Date();
  const path = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${String(now.getUTCDate()).padStart(2, "0")}.json`;
  const blob = new Blob([JSON.stringify(dump)], { type: "application/json" });

  const { error: upErr } = await supabase.storage.from("backups").upload(path, blob, {
    contentType: "application/json",
    upsert: true,
  });
  if (upErr) return Response.json({ ok: false, step: "upload", error: upErr.message }, { status: 500 });

  return Response.json({ ok: true, path, bytes: blob.size });
});
