import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import ProcessingClientsLastWeekClient from "./ProcessingClientsLastWeekClient";

export default async function ProcessingClientsLastWeekPage() {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_auth")?.value !== "true") {
    redirect("/login?from=/processing-clients-last-week");
  }
  return <ProcessingClientsLastWeekClient />;
}
