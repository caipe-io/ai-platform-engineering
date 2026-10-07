import { redirect } from "next/navigation";

export default function SettingsPage(): never {
  redirect("/settings/appearance");
}
