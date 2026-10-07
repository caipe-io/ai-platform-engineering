import { findAdminDestinationByPath } from "@/components/admin/workspace/admin-routes";
import { notFound } from "next/navigation";

import AdminPage from "../page";

export default async function AdminDestinationPage({
  params,
}: {
  params: Promise<{ path: string[] }>;
}): Promise<React.ReactElement> {
  const { path } = await params;
  const pathname = `/admin/${path.join("/")}`;

  if (!findAdminDestinationByPath(pathname)) notFound();

  return <AdminPage />;
}
