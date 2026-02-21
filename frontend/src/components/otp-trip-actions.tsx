import { useState, useEffect } from "react";
import { Loader2, Key, CheckCircle, Clock, AlertCircle, PlayCircle, StopCircle, RefreshCw, Navigation } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { 
  useRequestTripStartOtp, 
  useRequestTripEndOtp,
  useRequestRouteStartOtp,
  useVerifyOtp, 
  useOtpStatus 
} from "@/lib/api-hooks";
import { useQuery } from "@tanstack/react-query";
import type { Shipment, Load } from "@shared/schema";
import { ShipperRatingDialog } from "./shipper-rating-dialog";

interface OtpStatusData {
  startOtpApproved?: boolean;
  routeStartOtpApproved?: boolean;
  endOtpApproved?: boolean;
  pendingStartRequest?: boolean;
  pendingRouteStartRequest?: boolean;
  pendingEndRequest?: boolean;
}

interface OtpTripActionsProps {
  shipment: Shipment;
  loadStatus?: string;
  onStateChange?: () => void;
}

// Helper to check if a rating is pending for this shipment
const getRatingPendingKey = (shipmentId: string) => `rating_pending_${shipmentId}`;

export function OtpTripActions({ shipment, loadStatus, onStateChange }: OtpTripActionsProps) {
  const { toast } = useToast();
  const [otpDialogOpen, setOtpDialogOpen] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [otpType, setOtpType] = useState<"trip_start" | "route_start" | "trip_end">("trip_start");
  
  // Check if there's a pending rating for this shipment (survives component remounts)
  const [ratingDialogOpen, setRatingDialogOpen] = useState(() => {
    const pendingKey = getRatingPendingKey(shipment.id);
    return sessionStorage.getItem(pendingKey) === "true";
  });

  const { data: otpStatusRaw, refetch: refetchStatus } = useOtpStatus(shipment.id);
  
  // Always fetch load data to ensure shipperId is available for rating dialog
  const embeddedLoad = (shipment as any)?.load;
  const embeddedShipperId = embeddedLoad?.shipperId;
  
  const { data: loadData } = useQuery<Load>({
    queryKey: ["/api/loads", shipment.loadId],
    enabled: !!shipment.loadId, // Always fetch - don't skip based on embedded data
    staleTime: 60000,
  });

  // Use fetched load data first (more reliable), then embedded as fallback
  const effectiveShipperId = loadData?.shipperId || embeddedShipperId;

  const { data: shipperData } = useQuery<{ id: string; companyName: string | null; username: string }>({
    queryKey: ["/api/users", effectiveShipperId],
    enabled: !!effectiveShipperId,
  });
  
  // Effect to open rating dialog when shipperId becomes available after trip end
  useEffect(() => {
    const pendingKey = getRatingPendingKey(shipment.id);
    const hasPendingRating = sessionStorage.getItem(pendingKey) === "true";
    
    if (hasPendingRating && effectiveShipperId && !ratingDialogOpen) {
      setRatingDialogOpen(true);
    }
  }, [effectiveShipperId, shipment.id, ratingDialogOpen]);
  const otpStatus = otpStatusRaw as OtpStatusData | undefined;
  const requestStartMutation = useRequestTripStartOtp();
  const requestRouteStartMutation = useRequestRouteStartOtp();
  const requestEndMutation = useRequestTripEndOtp();
  const verifyMutation = useVerifyOtp();

  const canRequestStart = !shipment.startOtpVerified && !shipment.startOtpRequested;
  const hasStartPending = shipment.startOtpRequested && !shipment.startOtpVerified;
  const startApproved = otpStatus?.startOtpApproved && !shipment.startOtpVerified;

  const canRequestRouteStart = shipment.startOtpVerified && !(shipment as any).routeStartOtpVerified && !(shipment as any).routeStartOtpRequested;
  const hasRouteStartPending = (shipment as any).routeStartOtpRequested && !(shipment as any).routeStartOtpVerified;
  const routeStartApproved = otpStatus?.routeStartOtpApproved && !(shipment as any).routeStartOtpVerified;

  const canRequestEnd = (shipment as any).routeStartOtpVerified && !shipment.endOtpVerified && !shipment.endOtpRequested;
  const hasEndPending = shipment.endOtpRequested && !shipment.endOtpVerified;
  const endApproved = otpStatus?.endOtpApproved && !shipment.endOtpVerified;

  const handleRequestStart = async () => {
    try {
      await requestStartMutation.mutateAsync(shipment.id);
      toast({
        title: "OTP Requested",
        description: "Your trip start OTP request has been sent to admin for approval.",
      });
      refetchStatus();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to request OTP",
        variant: "destructive",
      });
    }
  };

  const handleRequestRouteStart = async () => {
    try {
      await requestRouteStartMutation.mutateAsync(shipment.id);
      toast({
        title: "OTP Requested",
        description: "Your route start OTP request has been sent to admin for approval.",
      });
      refetchStatus();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to request OTP",
        variant: "destructive",
      });
    }
  };

  const handleRequestEnd = async () => {
    try {
      await requestEndMutation.mutateAsync(shipment.id);
      toast({
        title: "OTP Requested",
        description: "Your trip end OTP request has been sent to admin for approval.",
      });
      refetchStatus();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to request OTP",
        variant: "destructive",
      });
    }
  };

  const handleVerifyOtp = async () => {
    if (!otpCode || otpCode.length !== 6) {
      toast({
        title: "Invalid OTP",
        description: "Please enter a valid 6-digit OTP.",
        variant: "destructive",
      });
      return;
    }

    try {
      await verifyMutation.mutateAsync({
        shipmentId: shipment.id,
        otpCode,
        otpType,
      });
      const titles: Record<string, string> = {
        trip_start: "Trip Started",
        route_start: "Route Started",
        trip_end: "Trip Completed"
      };
      const descriptions: Record<string, string> = {
        trip_start: "Trip initialized. Now request Route Start OTP to begin transit.",
        route_start: "Your route is now in transit. GPS tracking activated.",
        trip_end: "Your delivery has been confirmed. Great job!"
      };
      toast({
        title: titles[otpType],
        description: descriptions[otpType],
      });
      setOtpDialogOpen(false);
      setOtpCode("");
      onStateChange?.();
      refetchStatus();
      
      if (otpType === "trip_end") {
        // Store rating pending state in sessionStorage to survive component remounts
        // This will show the rating dialog when shipperId becomes available
        const pendingKey = getRatingPendingKey(shipment.id);
        sessionStorage.setItem(pendingKey, "true");
        // Open dialog immediately if shipperId is available, or the effect will handle it
        if (effectiveShipperId) {
          setRatingDialogOpen(true);
        }
      }
    } catch (error: any) {
      toast({
        title: "Verification Failed",
        description: error.message || "Invalid OTP. Please try again.",
        variant: "destructive",
      });
    }
  };

  const openOtpDialog = (type: "trip_start" | "route_start" | "trip_end") => {
    setOtpType(type);
    setOtpCode("");
    setOtpDialogOpen(true);
  };

  if (shipment.status === "delivered" || shipment.endOtpVerified) {
    return (
      <>
        <Card className="border-green-200 dark:border-green-800">
          <CardContent className="py-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400" />
              </div>
              <div>
                <p className="font-medium text-green-700 dark:text-green-400">Trip Completed</p>
                <p className="text-sm text-muted-foreground">Delivery confirmed via OTP verification</p>
              </div>
            </div>
          </CardContent>
        </Card>
        {effectiveShipperId && (
          <ShipperRatingDialog
            open={ratingDialogOpen}
            onOpenChange={(open) => {
              setRatingDialogOpen(open);
              if (!open) {
                // Clear the pending state when dialog closes
                sessionStorage.removeItem(getRatingPendingKey(shipment.id));
              }
            }}
            shipmentId={shipment.id}
            loadId={shipment.loadId}
            shipperId={effectiveShipperId}
            shipperName={shipperData?.companyName || shipperData?.username || "Shipper"}
          />
        )}
      </>
    );
  }

  return (
    <>
      <Card data-testid={`otp-card-${shipment.id}`}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Key className="h-5 w-5 text-primary" />
              <CardTitle className="text-base">OTP Security Gate</CardTitle>
            </div>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={() => refetchStatus()}
              data-testid="button-refresh-otp-status"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
          <CardDescription>
            Request OTP approval from admin to start or end your trip
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
            <div className="flex items-center gap-3">
              <div className={`h-8 w-8 rounded-full flex items-center justify-center ${
                shipment.startOtpVerified 
                  ? "bg-green-100 dark:bg-green-900/30" 
                  : hasStartPending || startApproved
                    ? "bg-amber-100 dark:bg-amber-900/30"
                    : "bg-muted"
              }`}>
                {shipment.startOtpVerified ? (
                  <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
                ) : hasStartPending || startApproved ? (
                  <Clock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                ) : (
                  <PlayCircle className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
              <div>
                <p className="font-medium text-sm">Trip Start</p>
                <p className="text-xs text-muted-foreground">
                  {shipment.startOtpVerified 
                    ? "Verified - Trip in progress" 
                    : startApproved
                      ? "Approved - Enter OTP"
                      : hasStartPending 
                        ? "Pending admin approval" 
                        : "Request OTP to start"}
                </p>
              </div>
            </div>
            {canRequestStart && (
              <Button 
                size="sm" 
                onClick={handleRequestStart}
                disabled={requestStartMutation.isPending}
                data-testid="button-request-start-otp"
              >
                {requestStartMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Request OTP"
                )}
              </Button>
            )}
            {startApproved && (
              <Button 
                size="sm" 
                onClick={() => openOtpDialog("trip_start")}
                data-testid="button-enter-start-otp"
              >
                <Key className="h-4 w-4 mr-1" />
                Enter OTP
              </Button>
            )}
            {hasStartPending && !startApproved && (
              <Badge variant="outline" className="bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400">
                <Clock className="h-3 w-3 mr-1" />
                Pending
              </Badge>
            )}
            {shipment.startOtpVerified && (
              <Badge variant="secondary" className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                <CheckCircle className="h-3 w-3 mr-1" />
                Verified
              </Badge>
            )}
          </div>

          <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
            <div className="flex items-center gap-3">
              <div className={`h-8 w-8 rounded-full flex items-center justify-center ${
                (shipment as any).routeStartOtpVerified 
                  ? "bg-green-100 dark:bg-green-900/30" 
                  : hasRouteStartPending || routeStartApproved
                    ? "bg-amber-100 dark:bg-amber-900/30"
                    : !shipment.startOtpVerified
                      ? "bg-muted opacity-50"
                      : "bg-muted"
              }`}>
                {(shipment as any).routeStartOtpVerified ? (
                  <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
                ) : hasRouteStartPending || routeStartApproved ? (
                  <Clock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                ) : (
                  <Navigation className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
              <div>
                <p className={`font-medium text-sm ${!shipment.startOtpVerified ? "opacity-50" : ""}`}>
                  Route Start
                </p>
                <p className="text-xs text-muted-foreground">
                  {(shipment as any).routeStartOtpVerified 
                    ? "Verified - In transit" 
                    : routeStartApproved
                      ? "Approved - Enter OTP"
                      : hasRouteStartPending 
                        ? "Pending admin approval" 
                        : !shipment.startOtpVerified
                          ? "Complete trip start first"
                          : "Request OTP to begin route"}
                </p>
              </div>
            </div>
            {canRequestRouteStart && (
              <Button 
                size="sm" 
                onClick={handleRequestRouteStart}
                disabled={requestRouteStartMutation.isPending}
                data-testid="button-request-route-start-otp"
              >
                {requestRouteStartMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Request OTP"
                )}
              </Button>
            )}
            {routeStartApproved && (
              <Button 
                size="sm" 
                onClick={() => openOtpDialog("route_start")}
                data-testid="button-enter-route-start-otp"
              >
                <Key className="h-4 w-4 mr-1" />
                Enter OTP
              </Button>
            )}
            {hasRouteStartPending && !routeStartApproved && (
              <Badge variant="outline" className="bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400">
                <Clock className="h-3 w-3 mr-1" />
                Pending
              </Badge>
            )}
            {!shipment.startOtpVerified && (
              <Badge variant="outline" className="opacity-50">
                <AlertCircle className="h-3 w-3 mr-1" />
                Locked
              </Badge>
            )}
            {(shipment as any).routeStartOtpVerified && (
              <Badge variant="secondary" className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                <CheckCircle className="h-3 w-3 mr-1" />
                Verified
              </Badge>
            )}
          </div>

          <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
            <div className="flex items-center gap-3">
              <div className={`h-8 w-8 rounded-full flex items-center justify-center ${
                shipment.endOtpVerified 
                  ? "bg-green-100 dark:bg-green-900/30" 
                  : hasEndPending || endApproved
                    ? "bg-amber-100 dark:bg-amber-900/30"
                    : !(shipment as any).routeStartOtpVerified
                      ? "bg-muted opacity-50"
                      : "bg-muted"
              }`}>
                {shipment.endOtpVerified ? (
                  <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
                ) : hasEndPending || endApproved ? (
                  <Clock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                ) : (
                  <StopCircle className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
              <div>
                <p className={`font-medium text-sm ${!(shipment as any).routeStartOtpVerified ? "opacity-50" : ""}`}>
                  Trip End
                </p>
                <p className="text-xs text-muted-foreground">
                  {shipment.endOtpVerified 
                    ? "Verified - Delivery complete" 
                    : endApproved
                      ? "Approved - Enter OTP"
                      : hasEndPending 
                        ? "Pending admin approval" 
                        : !(shipment as any).routeStartOtpVerified
                          ? "Start route first"
                          : "Request OTP to complete"}
                </p>
              </div>
            </div>
            {canRequestEnd && (
              <Button 
                size="sm" 
                onClick={handleRequestEnd}
                disabled={requestEndMutation.isPending}
                data-testid="button-request-end-otp"
              >
                {requestEndMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Request OTP"
                )}
              </Button>
            )}
            {endApproved && (
              <Button 
                size="sm" 
                onClick={() => openOtpDialog("trip_end")}
                data-testid="button-enter-end-otp"
              >
                <Key className="h-4 w-4 mr-1" />
                Enter OTP
              </Button>
            )}
            {hasEndPending && !endApproved && (
              <Badge variant="outline" className="bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400">
                <Clock className="h-3 w-3 mr-1" />
                Pending
              </Badge>
            )}
            {!(shipment as any).routeStartOtpVerified && (
              <Badge variant="outline" className="opacity-50">
                <AlertCircle className="h-3 w-3 mr-1" />
                Locked
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={otpDialogOpen} onOpenChange={setOtpDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {otpType === "trip_start" ? "Start Trip - Enter OTP" : otpType === "route_start" ? "Start Route - Enter OTP" : "Complete Trip - Enter OTP"}
            </DialogTitle>
            <DialogDescription>
              Enter the 6-digit OTP provided by admin to{" "}
              {otpType === "trip_start" ? "start your trip" : otpType === "route_start" ? "begin your route" : "confirm delivery"}.
            </DialogDescription>
          </DialogHeader>
          <div className="py-6">
            <Label htmlFor="otp-input" className="mb-2 block">One-Time Password</Label>
            <Input
              id="otp-input"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              placeholder="Enter 6-digit OTP"
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="text-center text-2xl tracking-[0.5em] font-mono"
              data-testid="input-otp-code"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOtpDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleVerifyOtp}
              disabled={verifyMutation.isPending || otpCode.length !== 6}
              data-testid="button-verify-otp"
            >
              {verifyMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Key className="h-4 w-4 mr-2" />
              )}
              {otpType === "trip_start" ? "Start Trip" : "Complete Delivery"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {effectiveShipperId && (
        <ShipperRatingDialog
          open={ratingDialogOpen}
          onOpenChange={(open) => {
            setRatingDialogOpen(open);
            if (!open) {
              // Clear the pending state when dialog closes
              sessionStorage.removeItem(getRatingPendingKey(shipment.id));
            }
          }}
          shipmentId={shipment.id}
          loadId={shipment.loadId}
          shipperId={effectiveShipperId}
          shipperName={shipperData?.companyName || shipperData?.username || "Shipper"}
        />
      )}
    </>
  );
}
