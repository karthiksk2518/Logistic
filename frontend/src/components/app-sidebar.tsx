import { Link, useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  Package,
  Truck,
  MessageSquare,
  MapPin,
  FileText,
  Users,
  BarChart3,
  Settings,
  Plus,
  Route,
  Gavel,
  Shield,
  Radio,
  DollarSign,
  User,
  History,
  ClipboardList,
  Key,
  UserCheck,
  CheckCircle,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { useAuth } from "@/lib/auth-context";
import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import type { LucideIcon } from "lucide-react";

interface NavItem {
  titleKey: string;
  url: string;
  icon: LucideIcon;
}

const shipperItems: NavItem[] = [
  { titleKey: "nav.dashboard", url: "/shipper", icon: LayoutDashboard },
  { titleKey: "nav.postLoad", url: "/shipper/post-load", icon: Plus },
  { titleKey: "nav.myLoads", url: "/shipper/loads", icon: Package },
  { titleKey: "nav.memos", url: "/shipper/invoices", icon: FileText },
  { titleKey: "nav.tracking", url: "/shipper/tracking", icon: Route },
  { titleKey: "nav.deliveredLoads", url: "/shipper/delivered", icon: CheckCircle },
  { titleKey: "nav.documents", url: "/shipper/documents", icon: FileText },
];

const carrierItems: NavItem[] = [
  { titleKey: "nav.dashboard", url: "/carrier", icon: LayoutDashboard },
  { titleKey: "fleet.addTruck", url: "/carrier/add-truck", icon: Plus },
  { titleKey: "nav.myFleet", url: "/carrier/fleet", icon: Truck },
  { titleKey: "nav.myDrivers", url: "/carrier/drivers", icon: User },
  { titleKey: "nav.myOrders", url: "/carrier/my-orders", icon: ClipboardList },
  { titleKey: "nav.availableLoads", url: "/carrier/loads", icon: Route },
  { titleKey: "nav.myBids", url: "/carrier/bids", icon: Gavel },
  { titleKey: "nav.myShipments", url: "/carrier/shipments", icon: Package },
  { titleKey: "nav.activeTrips", url: "/carrier/trips", icon: MapPin },
  { titleKey: "nav.tripHistory", url: "/carrier/history", icon: History },
  { titleKey: "nav.revenue", url: "/carrier/revenue", icon: DollarSign },
  { titleKey: "nav.documents", url: "/carrier/my-documents", icon: FileText },
];

const soloItems: NavItem[] = [
  { titleKey: "nav.dashboard", url: "/carrier", icon: LayoutDashboard },
  { titleKey: "nav.myTruck", url: "/carrier/my-truck", icon: Truck },
  { titleKey: "nav.myInfo", url: "/carrier/my-info", icon: User },
  { titleKey: "nav.myOrders", url: "/carrier/my-orders", icon: ClipboardList },
  { titleKey: "nav.availableLoads", url: "/carrier/loads", icon: Route },
  { titleKey: "nav.myBids", url: "/carrier/bids", icon: Gavel },
  { titleKey: "nav.myShipments", url: "/carrier/shipments", icon: Package },
  { titleKey: "nav.activeTrips", url: "/carrier/trips", icon: MapPin },
  { titleKey: "nav.tripHistory", url: "/carrier/history", icon: History },
  { titleKey: "nav.revenue", url: "/carrier/revenue", icon: DollarSign },
  { titleKey: "nav.myDocuments", url: "/carrier/my-documents", icon: FileText },
];

const adminItems: NavItem[] = [
  { titleKey: "nav.overview", url: "/admin", icon: LayoutDashboard },
  { titleKey: "nav.postLoad", url: "/admin/post-load", icon: Plus },
  { titleKey: "nav.loadQueue", url: "/admin/queue", icon: ClipboardList },
  { titleKey: "nav.bidsNegotiations", url: "/admin/negotiations", icon: Gavel },
  { titleKey: "nav.otpVerification", url: "/admin/otp-queue", icon: Key },
  { titleKey: "nav.liveTracking", url: "/admin/live-tracking", icon: Radio },
  { titleKey: "nav.shipperOnboarding", url: "/admin/onboarding", icon: UserCheck },
  { titleKey: "nav.memos", url: "/admin/invoices", icon: FileText },
  { titleKey: "nav.users", url: "/admin/users", icon: Users },
  { titleKey: "nav.allLoads", url: "/admin/loads", icon: Package },
  { titleKey: "nav.carriers", url: "/admin/carriers", icon: Truck },
  { titleKey: "nav.verification", url: "/admin/verification", icon: Shield },
  { titleKey: "nav.documentReview", url: "/admin/finance-review", icon: FileText },
  { titleKey: "nav.reports", url: "/admin/reports", icon: BarChart3 },
];

export function AppSidebar() {
  const [location] = useLocation();
  const { user, carrierType } = useAuth();
  const { t } = useTranslation();

  // Detect solo carrier from carrierType
  const isSoloCarrier = user?.role === "carrier" && carrierType === "solo";

  // Fetch shipper onboarding data to determine if they are a transporter
  const { data: onboardingData } = useQuery<any>({
    queryKey: ["/api/shipper/onboarding"],
    enabled: user?.role === "shipper",
  });
  const isTransporter = user?.role === "shipper" && onboardingData?.shipperRole === "transporter";

  const getNavItems = () => {
    switch (user?.role) {
      case "shipper":
        return shipperItems;
      case "carrier":
        return isSoloCarrier ? soloItems : carrierItems;
      case "admin":
        return adminItems;
      default:
        return shipperItems;
    }
  };

  const getRoleLabel = () => {
    switch (user?.role) {
      case "shipper":
        return isTransporter ? "Transporter Portal" : t("roles.shipperPortal");
      case "carrier":
        return isSoloCarrier ? t("roles.soloDriver") : t("roles.carrierPortal");
      case "admin":
        return t("roles.adminConsole");
      default:
        return "Portal";
    }
  };

  const getRoleBadgeVariant = () => {
    switch (user?.role) {
      case "admin":
        return "destructive";
      case "carrier":
        return "secondary";
      default:
        return "default";
    }
  };

  const items = getNavItems();

  return (
    <Sidebar>
      <SidebarHeader className="p-6 border-b border-sidebar-border">
        <div className="flex flex-col gap-3">
          <img 
            src="/assets/Purple_and_Black_Modern_Software_Developer_LinkedIn_Banner_1770118882647.png" 
            alt="Load Smart" 
            className="w-full h-auto object-contain"
            data-testid="text-app-name"
          />
          <Badge variant={getRoleBadgeVariant()} className="w-fit text-xs">
            {getRoleLabel()}
          </Badge>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t("sections.navigation")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => {
                const isActive = location === item.url || 
                  (item.url !== "/" && location.startsWith(item.url) && item.url.split("/").length > 2);
                const title = t(item.titleKey);
                return (
                  <SidebarMenuItem key={item.titleKey}>
                    <SidebarMenuButton asChild data-active={isActive}>
                      <Link href={item.url} data-testid={`link-nav-${item.titleKey.replace(/\./g, "-")}`}>
                        <item.icon className="h-4 w-4" />
                        <span>{title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>{t("common.settings")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild data-active={location === "/settings"}>
                  <Link href="/settings" data-testid="link-nav-settings">
                    <Settings className="h-4 w-4" />
                    <span>{t("common.settings")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4 border-t border-sidebar-border">
        {user && (
          <div className="flex items-center gap-3">
            <Avatar>
              <AvatarFallback className="bg-primary/10 text-primary">
                {user.username?.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="flex flex-col min-w-0 flex-1">
              <span className="text-sm font-medium truncate" data-testid="text-username">
                {user.username}
              </span>
              <span className="text-xs text-muted-foreground truncate">
                {user.companyName || user.email}
              </span>
            </div>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
