import { redirect } from "next/navigation";
import { currentSession } from "@/lib/command";

export default async function Home() {
  redirect((await currentSession()) ? "/recall" : "/login");
}
