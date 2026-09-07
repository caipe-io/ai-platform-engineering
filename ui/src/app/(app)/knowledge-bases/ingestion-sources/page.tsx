import { redirect } from "next/navigation";

// Ingestion source management now lives in the merged "Data Sources" tab —
// redirect rather than delete so old links/bookmarks still land somewhere.
export default function IngestionSourcesRedirectPage() {
  redirect("/knowledge-bases/ingest");
}
