import {
  Bot,
  Compass,
  Cpu,
  KeyRound,
  MessageSquare,
  Server,
  Settings,
  Sparkles,
} from "lucide-react";
import type { TourIcon } from "@/lib/product-tour-catalog";

export const TOUR_ICONS = {
  agent: Bot,
  compass: Compass,
  model: Cpu,
  credentials: KeyRound,
  chat: MessageSquare,
  server: Server,
  settings: Settings,
  sparkles: Sparkles,
} satisfies Record<TourIcon, typeof Compass>;
