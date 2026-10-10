import { notFound, redirect } from "next/navigation";

import { NativeExtensionHost } from "@/native-extensions/NativeExtensionHost";
import { nativeExtensionById } from "@/native-extensions/runtime";
import { canEnterNativeExtension } from "@/native-extensions/access";

export default async function NativeExtensionLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ extensionId: string }>;
}): Promise<React.ReactElement> {
  const { extensionId } = await params;
  if (!nativeExtensionById(extensionId)) notFound();
  if (!(await canEnterNativeExtension(extensionId))) redirect("/unauthorized");

  return (
    <NativeExtensionHost extensionId={extensionId}>
      {children}
    </NativeExtensionHost>
  );
}
