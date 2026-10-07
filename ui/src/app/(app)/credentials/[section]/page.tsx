import { notFound } from "next/navigation";

import {
  CredentialsWorkspace,
  type CredentialsSection,
} from "@/components/credentials/CredentialsWorkspace";

const VALID_SECTIONS: CredentialsSection[] = ["connections","secrets"];

export default async function CredentialsSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}): Promise<React.ReactElement> {
  const { section } = await params;
  if (!VALID_SECTIONS.includes(section as CredentialsSection)) notFound();

  return <CredentialsWorkspace activeSection={section as CredentialsSection} />;
}
