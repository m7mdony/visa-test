import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import InHouseVerVideosClient from "./InHouseVerVideosClient";

export default async function InHouseVerVideosPage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/in-house-ver-videos");
  }
  return <InHouseVerVideosClient />;
}
