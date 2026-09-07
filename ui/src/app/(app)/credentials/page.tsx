import { redirect } from "next/navigation";

export default function CredentialsPage(): never {
  redirect("/credentials/connections");
}
