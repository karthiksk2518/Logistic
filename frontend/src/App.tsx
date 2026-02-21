import { Suspense, lazy, useState, useEffect } from "react";
import { Switch, Route, Redirect, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/lib/theme-provider";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { LanguageSwitcher } from "@/components/language-switcher";
import { NotificationPanel } from "@/components/notification-panel";
import { GlobalSearch } from "@/components/global-search";
import { HelpBotWidget } from "@/components/HelpBotWidget";
import { MockDataProvider } from "@/lib/mock-data-store";
import { DocumentVaultProvider } from "@/lib/document-vault-store";
import { AdminDataProvider } from "@/lib/admin-data-store";
import { CarrierDataProvider } from "@/lib/carrier-data-store";
import { CarrierOtpNotification } from "@/components/carrier-otp-notification";
import { CarrierOnboardingGate } from "@/hooks/use-carrier-onboarding-gate";
import { ShipperOnboardingGate } from "@/hooks/use-shipper-onboarding-gate";
import { AdminVerificationBanner } from "@/components/admin-verification-banner";

import AuthPage from "@/pages/auth";
const NotFound = lazy(() => import("@/pages/not-found"));
const SettingsPage = lazy(() => import("@/pages/settings"));
const LandingPage = lazy(() => import("@/pages/landing"));
const LoadBoardPage = lazy(() => import("@/pages/load-board"));
const ContactPage = lazy(() => import("@/pages/contact"));
const ForDriversPage = lazy(() => import("@/pages/solutions/for-drivers"));
const ForCarriersPage = lazy(() => import("@/pages/solutions/for-carriers"));
const ForShippersPage = lazy(() => import("@/pages/solutions/for-shippers"));
const FAQsPage = lazy(() => import("@/pages/faqs"));
const PressRoomPage = lazy(() => import("@/pages/press-room"));
const AboutPage = lazy(() => import("@/pages/about"));

const ShipperDashboard = lazy(() => import("@/pages/shipper").then(m => ({ default: m.ShipperDashboard })));
const PostLoadPage = lazy(() => import("@/pages/shipper").then(m => ({ default: m.PostLoadPage })));
const ShipperLoadsPage = lazy(() => import("@/pages/shipper").then(m => ({ default: m.ShipperLoadsPage })));
const LoadDetailPage = lazy(() => import("@/pages/shipper").then(m => ({ default: m.LoadDetailPage })));
const TrackingPage = lazy(() => import("@/pages/shipper").then(m => ({ default: m.TrackingPage })));
const DeliveredLoadsPage = lazy(() => import("@/pages/shipper").then(m => ({ default: m.DeliveredLoadsPage })));
const ShipperDocumentsPage = lazy(() => import("@/pages/shipper").then(m => ({ default: m.ShipperDocumentsPage })));
const ShipperInvoicesPage = lazy(() => import("@/pages/shipper").then(m => ({ default: m.ShipperInvoicesPage })));
const ShipperOnboardingPage = lazy(() => import("@/pages/shipper").then(m => ({ default: m.ShipperOnboardingPage })));

const CarrierDashboard = lazy(() => import("@/pages/carrier").then(m => ({ default: m.CarrierDashboard })));
const AddTruckPage = lazy(() => import("@/pages/carrier").then(m => ({ default: m.AddTruckPage })));
const FleetPage = lazy(() => import("@/pages/carrier").then(m => ({ default: m.FleetPage })));
const CarrierLoadsPage = lazy(() => import("@/pages/carrier").then(m => ({ default: m.CarrierLoadsPage })));
const CarrierBidsPage = lazy(() => import("@/pages/carrier").then(m => ({ default: m.CarrierBidsPage })));
const TripsPage = lazy(() => import("@/pages/carrier").then(m => ({ default: m.TripsPage })));
const CarrierDocumentsPage = lazy(() => import("@/pages/carrier").then(m => ({ default: m.CarrierDocumentsPage })));
const CarrierRevenuePage = lazy(() => import("@/pages/carrier").then(m => ({ default: m.CarrierRevenuePage })));
const CarrierDriversPage = lazy(() => import("@/pages/carrier").then(m => ({ default: m.CarrierDriversPage })));
const CarrierHistoryPage = lazy(() => import("@/pages/carrier").then(m => ({ default: m.CarrierHistoryPage })));
const CarrierShipmentsPage = lazy(() => import("@/pages/carrier").then(m => ({ default: m.CarrierShipmentsPage })));
const MyTruckPage = lazy(() => import("@/pages/carrier").then(m => ({ default: m.MyTruckPage })));
const MyInfoPage = lazy(() => import("@/pages/carrier").then(m => ({ default: m.MyInfoPage })));
const MyDocumentsPage = lazy(() => import("@/pages/carrier").then(m => ({ default: m.MyDocumentsPage })));
const CarrierOnboardingPage = lazy(() => import("@/pages/carrier").then(m => ({ default: m.CarrierOnboardingPage })));
const CarrierMyOrdersPage = lazy(() => import("@/pages/carrier").then(m => ({ default: m.CarrierMyOrdersPage })));

const SoloLoadFeed = lazy(() => import("@/pages/solo").then(m => ({ default: m.SoloLoadFeed })));
const SoloMyBids = lazy(() => import("@/pages/solo").then(m => ({ default: m.SoloMyBids })));
const SoloMyTrips = lazy(() => import("@/pages/solo").then(m => ({ default: m.SoloMyTrips })));
const SoloEarnings = lazy(() => import("@/pages/solo").then(m => ({ default: m.SoloEarnings })));

const AdminOverview = lazy(() => import("@/pages/admin").then(m => ({ default: m.AdminOverview })));
const AdminUsersPage = lazy(() => import("@/pages/admin").then(m => ({ default: m.AdminUsersPage })));
const AdminLoadsPage = lazy(() => import("@/pages/admin").then(m => ({ default: m.AdminLoadsPage })));
const AdminLoadDetailsPage = lazy(() => import("@/pages/admin").then(m => ({ default: m.AdminLoadDetailsPage })));
const AdminCarriersPage = lazy(() => import("@/pages/admin").then(m => ({ default: m.AdminCarriersPage })));
const CarrierProfilePage = lazy(() => import("@/pages/admin").then(m => ({ default: m.CarrierProfilePage })));
const AdminVolumeAnalytics = lazy(() => import("@/pages/admin").then(m => ({ default: m.AdminVolumeAnalytics })));
const RevenueDashboard = lazy(() => import("@/pages/admin").then(m => ({ default: m.RevenueDashboard })));
const AdminLoadQueuePage = lazy(() => import("@/pages/admin").then(m => ({ default: m.AdminLoadQueuePage })));
const AdminNegotiationsPage = lazy(() => import("@/pages/admin").then(m => ({ default: m.AdminNegotiationsPage })));
const AdminInvoicesPage = lazy(() => import("@/pages/admin").then(m => ({ default: m.AdminInvoicesPage })));
const AdminCarrierVerificationPage = lazy(() => import("@/pages/admin").then(m => ({ default: m.AdminCarrierVerificationPage })));
const AdminOnboardingPage = lazy(() => import("@/pages/admin").then(m => ({ default: m.AdminOnboardingPage })));
const AdminLiveTrackingPage = lazy(() => import("@/pages/admin").then(m => ({ default: m.AdminLiveTrackingPage })));
const NegotiationInbox = lazy(() => import("@/pages/admin").then(m => ({ default: m.NegotiationInbox })));
const AdminOtpQueuePage = lazy(() => import("@/pages/admin").then(m => ({ default: m.AdminOtpQueuePage })));
const AdminNearbyTrucksPage = lazy(() => import("@/pages/admin").then(m => ({ default: m.AdminNearbyTrucksPage })));
const AdminPostLoadPage = lazy(() => import("@/pages/admin").then(m => ({ default: m.AdminPostLoadPage })));

const FinanceDashboard = lazy(() => import("@/pages/finance/dashboard"));

function PageLoader() {
  return (
    <div className="flex h-full items-center justify-center min-h-[200px] bg-background">
      <div className="flex flex-col items-center gap-4">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="text-muted-foreground text-sm">Loading page...</p>
      </div>
    </div>
  );
}

function AppContent() {
  const { user, isLoading } = useAuth();
  const [location] = useLocation();
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth < 768 || 
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    
    const checkMobile = () => {
      const mobile = window.innerWidth < 768 || 
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      setIsMobile(mobile);
    };

    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-6">
          <div className="text-2xl font-bold text-primary">LoadSmart</div>
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-muted-foreground text-sm">Starting up...</p>
        </div>
      </div>
    );
  }

  if (!user && location === "/" && !isMobile) {
    return (
      <Suspense fallback={<PageLoader />}>
        <LandingPage />
      </Suspense>
    );
  }

  if (!user && location === "/load-board") {
    return (
      <Suspense fallback={<PageLoader />}>
        <LoadBoardPage />
      </Suspense>
    );
  }

  if (!user && location === "/contact") {
    return (
      <Suspense fallback={<PageLoader />}>
        <ContactPage />
      </Suspense>
    );
  }

  if (!user && location === "/solutions/drivers") {
    return (
      <Suspense fallback={<PageLoader />}>
        <ForDriversPage />
      </Suspense>
    );
  }

  if (!user && location === "/solutions/carriers") {
    return (
      <Suspense fallback={<PageLoader />}>
        <ForCarriersPage />
      </Suspense>
    );
  }

  if (!user && location === "/solutions/shippers") {
    return (
      <Suspense fallback={<PageLoader />}>
        <ForShippersPage />
      </Suspense>
    );
  }

  if (!user && location === "/faqs") {
    return (
      <Suspense fallback={<PageLoader />}>
        <FAQsPage />
      </Suspense>
    );
  }

  if (!user && location === "/press-room") {
    return (
      <Suspense fallback={<PageLoader />}>
        <PressRoomPage />
      </Suspense>
    );
  }

  if (!user && location === "/about") {
    return (
      <Suspense fallback={<PageLoader />}>
        <AboutPage />
      </Suspense>
    );
  }

  if (!user && location !== "/auth" && location !== "/" && location !== "/load-board" && location !== "/contact" && !location.startsWith("/solutions/") && location !== "/faqs" && location !== "/press-room" && location !== "/about") {
    return <Redirect to="/auth" />;
  }

  if (!user && location === "/" && isMobile) {
    return <Redirect to="/auth" />;
  }

  if (location === "/auth" && user) {
    const defaultRoute = user.role === "admin" ? "/admin" : user.role === "carrier" ? "/carrier" : "/shipper";
    return <Redirect to={defaultRoute} />;
  }

  if (location === "/auth" || (location === "/" && !user)) {
    return <AuthPage />;
  }

  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "4rem",
  };

  return (
    <SidebarProvider style={style as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <header className="flex items-center justify-between gap-2 sm:gap-4 p-2 sm:p-3 border-b border-border sticky top-0 z-50 bg-background">
            <SidebarTrigger data-testid="button-sidebar-toggle" className="shrink-0" />
            <div className="flex-1 flex justify-center min-w-0 px-1 sm:px-2">
              <GlobalSearch />
            </div>
            <div className="flex items-center gap-1 sm:gap-2 shrink-0">
              <NotificationPanel />
              <span className="hidden sm:inline-flex">
                <LanguageSwitcher />
              </span>
              <ThemeToggle />
            </div>
          </header>
          <AdminVerificationBanner />
          <main className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
            <Suspense fallback={<PageLoader />}>
              <Switch>
                <Route path="/" component={() => {
                  const defaultRoute = user?.role === "admin" ? "/admin" : user?.role === "carrier" ? "/carrier" : "/shipper";
                  return <Redirect to={defaultRoute} />;
                }} />
                
                <Route path="/shipper" component={() => <ShipperOnboardingGate><ShipperDashboard /></ShipperOnboardingGate>} />
                <Route path="/shipper/post-load" component={() => <ShipperOnboardingGate><PostLoadPage /></ShipperOnboardingGate>} />
                <Route path="/shipper/loads" component={() => <ShipperOnboardingGate><ShipperLoadsPage /></ShipperOnboardingGate>} />
                <Route path="/shipper/loads/:id" component={() => <ShipperOnboardingGate><LoadDetailPage /></ShipperOnboardingGate>} />
                <Route path="/shipper/tracking" component={() => <ShipperOnboardingGate><TrackingPage /></ShipperOnboardingGate>} />
                <Route path="/shipper/delivered" component={() => <ShipperOnboardingGate><DeliveredLoadsPage /></ShipperOnboardingGate>} />
                <Route path="/shipper/documents" component={() => <ShipperOnboardingGate><ShipperDocumentsPage /></ShipperOnboardingGate>} />
                <Route path="/shipper/invoices" component={() => <ShipperOnboardingGate><ShipperInvoicesPage /></ShipperOnboardingGate>} />
                <Route path="/shipper/onboarding" component={ShipperOnboardingPage} />
                              
                <Route path="/carrier" component={() => <CarrierOnboardingGate><CarrierDashboard /></CarrierOnboardingGate>} />
                <Route path="/carrier/add-truck" component={() => <CarrierOnboardingGate><AddTruckPage /></CarrierOnboardingGate>} />
                <Route path="/carrier/fleet" component={() => <CarrierOnboardingGate><FleetPage /></CarrierOnboardingGate>} />
                <Route path="/carrier/loads" component={() => <CarrierOnboardingGate><CarrierLoadsPage /></CarrierOnboardingGate>} />
                <Route path="/carrier/bids" component={() => <CarrierOnboardingGate><CarrierBidsPage /></CarrierOnboardingGate>} />
                <Route path="/carrier/trips" component={() => <CarrierOnboardingGate><TripsPage /></CarrierOnboardingGate>} />
                <Route path="/carrier/documents" component={() => <CarrierOnboardingGate><CarrierDocumentsPage /></CarrierOnboardingGate>} />
                <Route path="/carrier/revenue" component={() => <CarrierOnboardingGate><CarrierRevenuePage /></CarrierOnboardingGate>} />
                <Route path="/carrier/drivers" component={() => <CarrierOnboardingGate><CarrierDriversPage /></CarrierOnboardingGate>} />
                <Route path="/carrier/history" component={() => <CarrierOnboardingGate><CarrierHistoryPage /></CarrierOnboardingGate>} />
                <Route path="/carrier/shipments" component={() => <CarrierOnboardingGate><CarrierShipmentsPage /></CarrierOnboardingGate>} />
                <Route path="/carrier/my-truck" component={() => <CarrierOnboardingGate><MyTruckPage /></CarrierOnboardingGate>} />
                <Route path="/carrier/my-info" component={() => <CarrierOnboardingGate><MyInfoPage /></CarrierOnboardingGate>} />
                <Route path="/carrier/my-documents" component={() => <CarrierOnboardingGate><MyDocumentsPage /></CarrierOnboardingGate>} />
                <Route path="/carrier/my-orders" component={() => <CarrierOnboardingGate><CarrierMyOrdersPage /></CarrierOnboardingGate>} />
                <Route path="/carrier/onboarding" component={CarrierOnboardingPage} />
                
                <Route path="/solo" component={() => <CarrierOnboardingGate><SoloLoadFeed /></CarrierOnboardingGate>} />
                <Route path="/solo/loads" component={() => <CarrierOnboardingGate><SoloLoadFeed /></CarrierOnboardingGate>} />
                <Route path="/solo/bids" component={() => <CarrierOnboardingGate><SoloMyBids /></CarrierOnboardingGate>} />
                <Route path="/solo/trips" component={() => <CarrierOnboardingGate><SoloMyTrips /></CarrierOnboardingGate>} />
                <Route path="/solo/earnings" component={() => <CarrierOnboardingGate><SoloEarnings /></CarrierOnboardingGate>} />
                
                <Route path="/admin" component={AdminOverview} />
                <Route path="/admin/post-load" component={AdminPostLoadPage} />
                <Route path="/admin/queue" component={AdminLoadQueuePage} />
                <Route path="/admin/negotiations" component={AdminNegotiationsPage} />
                <Route path="/admin/inbox" component={NegotiationInbox} />
                <Route path="/admin/users" component={AdminUsersPage} />
                <Route path="/admin/users/:id" component={AdminUsersPage} />
                <Route path="/admin/loads" component={AdminLoadsPage} />
                <Route path="/admin/loads/:loadId" component={AdminLoadDetailsPage} />
                <Route path="/admin/carriers" component={AdminCarriersPage} />
                <Route path="/admin/carriers/:carrierId" component={CarrierProfilePage} />
                <Route path="/admin/volume" component={AdminVolumeAnalytics} />
                <Route path="/admin/analytics" component={AdminVolumeAnalytics} />
                <Route path="/admin/revenue" component={RevenueDashboard} />
                <Route path="/admin/revenue/:metric" component={RevenueDashboard} />
                <Route path="/admin/nearby-trucks" component={AdminNearbyTrucksPage} />
                <Route path="/admin/verification" component={AdminCarrierVerificationPage} />
                <Route path="/admin/onboarding" component={AdminOnboardingPage} />
                <Route path="/admin/reports" component={AdminVolumeAnalytics} />
                <Route path="/admin/invoices" component={AdminInvoicesPage} />
                <Route path="/admin/otp-queue" component={AdminOtpQueuePage} />
                <Route path="/admin/live-tracking" component={AdminLiveTrackingPage} />
                <Route path="/admin/finance-review" component={FinanceDashboard} />
                
                <Route path="/settings" component={SettingsPage} />
                
                <Route component={NotFound} />
              </Switch>
            </Suspense>
          </main>
        </div>
      </div>
      <CarrierOtpNotification />
    </SidebarProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <MockDataProvider>
            <DocumentVaultProvider>
              <AdminDataProvider>
                <CarrierDataProvider>
                  <TooltipProvider>
                    <AppContent />
                    <Toaster />
                    <HelpBotWidget />
                  </TooltipProvider>
                </CarrierDataProvider>
              </AdminDataProvider>
            </DocumentVaultProvider>
          </MockDataProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
