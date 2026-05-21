import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import ClientsMissingVideosClient from "./ClientsMissingVideosClient";

export default async function ClientsMissingVideosPage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/clients-missing-videos");
  }
  return <ClientsMissingVideosClient />;
}
