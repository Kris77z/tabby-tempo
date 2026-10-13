"use client";
import { createContext, useContext, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useHostedAgentsController } from "./use-hosted-agents";

type State = ReturnType<typeof useHostedAgentsController>;
const HostedContext = createContext<State | null>(null);

/** One session controller for both hosted routes. No reads before a consumer mounts. */
export function HostedAgentsProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const state = useHostedAgentsController(["/dashboard", "/onboarding", "/finance", "/arena"].includes(pathname));
  return <HostedContext.Provider value={state}>{children}</HostedContext.Provider>;
}

export function useHostedAgents() {
  const context = useContext(HostedContext);
  if (!context) throw new Error("HostedAgentsProvider is required.");
  return context;
}
