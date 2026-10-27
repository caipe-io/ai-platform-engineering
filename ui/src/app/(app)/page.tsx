import { canEnterNativeExtension } from "@/native-extensions/access";
import { nativeExtensionForSlot } from "@/native-extensions/runtime";
import { HomePageClient } from "./home-page-client";

export default async function HomePage(): Promise<React.ReactElement> {
  const extension = nativeExtensionForSlot("home");
  const showNativeSlot = extension
    ? await canEnterNativeExtension(extension.id)
    : false;
  return <HomePageClient showNativeSlot={showNativeSlot} />;
}
