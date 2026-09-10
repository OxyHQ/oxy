import { useState } from "react"
import { useAuth } from "@oxy.so/services"
import { AppSidebar, type Page } from "@/components/app-sidebar"
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { AuthDemo } from "@/pages/AuthDemo"
import { ProfileDemo } from "@/pages/ProfileDemo"
import { SessionsDemo } from "@/pages/SessionsDemo"
import { FilesDemo } from "@/pages/FilesDemo"
import { SocialDemo } from "@/pages/SocialDemo"
import { SecurityDemo } from "@/pages/SecurityDemo"

const pageLabels: Record<Page, string> = {
  auth: "Authentication",
  profile: "Profile",
  sessions: "Sessions & Devices",
  files: "Files & Assets",
  social: "Social",
  security: "Security",
}

const pages: Record<Page, React.ComponentType> = {
  auth: AuthDemo,
  profile: ProfileDemo,
  sessions: SessionsDemo,
  files: FilesDemo,
  social: SocialDemo,
  security: SecurityDemo,
}

export default function App() {
  const [activePage, setActivePage] = useState<Page>("auth")
  const { isAuthenticated, user } = useAuth()
  const ActivePage = pages[activePage]

  return (
    <SidebarProvider>
      <AppSidebar activePage={activePage} onNavigate={setActivePage} />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 !h-4" />
          <h1 className="text-sm font-medium">{pageLabels[activePage]}</h1>
          <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
            {isAuthenticated ? (
              <span>Signed in as <strong className="text-foreground">{user?.username || user?.email}</strong></span>
            ) : (
              <span>Not signed in</span>
            )}
          </div>
        </header>
        <div className="flex-1 overflow-auto p-4">
          <ActivePage />
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
