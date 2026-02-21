import { useState } from "react";
import { useLocation } from "wouter";
import { Loader2, CheckCircle, XCircle, Clock, RefreshCw, Key, Truck, MapPin, Copy, Phone, MessageSquare, User, Building2, ChevronDown, ChevronUp, Mail } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useOtpRequests, useApproveOtpRequest, useRejectOtpRequest, useRegenerateOtpRequest, type OtpRequest, invalidateOtpRequests } from "@/lib/api-hooks";
import { formatDistanceToNow, format } from "date-fns";

function formatLoadId(load?: { adminReferenceNumber?: number | null; shipperLoadNumber?: number | string | null; id?: string }): string {
  if (load?.adminReferenceNumber) {
    return `LD-${load.adminReferenceNumber}`;
  }
  if (load?.shipperLoadNumber) {
    const ref = String(load.shipperLoadNumber);
    // Avoid duplicating LD- prefix if already present
    if (ref.startsWith("LD-") || ref.startsWith("ld-")) {
      return ref.toUpperCase();
    }
    return `LD-${ref}`;
  }
  // Fallback to truncated load ID if available
  if (load?.id) {
    return `#${load.id.slice(0, 6)}`;
  }
  return "Unknown";
}

interface OtpRequestCardProps {
  request: OtpRequest;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

function OtpRequestCard({ request, onApprove, onReject }: OtpRequestCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  
  const typeLabels: Record<string, string> = {
    trip_start: "Trip Start",
    route_start: "Route Start",
    trip_end: "Trip End",
    registration: "Registration"
  };
  const typeColors: Record<string, string> = {
    trip_start: "bg-green-500/10 text-green-600 dark:text-green-400",
    route_start: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    trip_end: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    registration: "bg-purple-500/10 text-purple-600 dark:text-purple-400"
  };
  const typeLabel = typeLabels[request.requestType] || "Unknown";
  const typeColor = typeColors[request.requestType] || "bg-muted text-muted-foreground";

  const isSoloDriver = (request as any).isSoloDriver;
  const assignedDriver = (request as any).assignedDriver;
  const assignedTruck = (request as any).assignedTruck;
  
  return (
    <Card className="mb-3" data-testid={`otp-request-card-${request.id}`}>
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CardContent className="pt-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge className={typeColor}>{typeLabel}</Badge>
                <Badge variant="outline">{formatLoadId(request.load)}</Badge>
                {isSoloDriver ? (
                  <Badge variant="secondary" className="text-xs">Solo Driver</Badge>
                ) : (
                  <Badge variant="secondary" className="text-xs">Enterprise</Badge>
                )}
              </div>
              <span className="text-xs text-muted-foreground">
                <Clock className="inline h-3 w-3 mr-1" />
                {request.requestedAt ? formatDistanceToNow(new Date(request.requestedAt), { addSuffix: true }) : "Just now"}
              </span>
            </div>
            
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm">
                {isSoloDriver ? (
                  <User className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="font-medium">
                  {isSoloDriver 
                    ? ((request.carrier as any)?.driverName || request.carrier?.username || "Unknown Driver")
                    : (request.carrier?.companyName || request.carrier?.username || "Unknown Carrier")
                  }
                </span>
              </div>
              {request.load && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <MapPin className="h-4 w-4" />
                  <span>{request.load.pickupCity || "—"} → {request.load.deliveryCity || "—"}</span>
                </div>
              )}
            </div>

            <CollapsibleTrigger asChild>
              <Button 
                variant="ghost" 
                size="sm" 
                className="w-full justify-center text-muted-foreground"
                data-testid={`button-expand-${request.id}`}
              >
                {isExpanded ? (
                  <>
                    <ChevronUp className="h-4 w-4 mr-1" />
                    Hide Details
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-4 w-4 mr-1" />
                    View Driver Details
                  </>
                )}
              </Button>
            </CollapsibleTrigger>

            <CollapsibleContent>
              <Separator className="my-2" />
              <div className="space-y-3 py-2">
                {isSoloDriver ? (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Solo Driver Details</p>
                      <div className="grid grid-cols-1 gap-2 text-sm">
                        <div className="flex items-center gap-2">
                          <User className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Name:</span>
                          <span className="font-medium">{(request.carrier as any)?.driverName || request.carrier?.username || "—"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Phone className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Phone:</span>
                          <span className="font-medium">{request.carrier?.phone || "—"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <MapPin className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Location:</span>
                          <span className="font-medium">{(request.carrier as any)?.location || "Not specified"}</span>
                        </div>
                      </div>
                    </div>
                    
                    <Separator />
                    
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Truck Details</p>
                      {assignedTruck ? (
                        <div className="grid grid-cols-1 gap-2 text-sm">
                          <div className="flex items-center gap-2">
                            <Truck className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Truck Type:</span>
                            <span className="font-medium">{assignedTruck.truckType || "—"}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <MapPin className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Truck Location:</span>
                            <span className="font-medium">{(assignedTruck as any).truckLocation || "Not specified"}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-muted-foreground ml-6">License Plate:</span>
                            <span className="font-medium">{assignedTruck.licensePlate || assignedTruck.registrationNumber || "—"}</span>
                          </div>
                          {(assignedTruck.manufacturer || assignedTruck.model) && (
                            <div className="flex items-center gap-2">
                              <span className="text-muted-foreground ml-6">Vehicle:</span>
                              <span className="font-medium">{[assignedTruck.manufacturer, assignedTruck.model].filter(Boolean).join(" ") || "—"}</span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground italic">No truck assigned yet</p>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Enterprise Details</p>
                      <div className="grid grid-cols-1 gap-2 text-sm">
                        <div className="flex items-center gap-2">
                          <Building2 className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Company Name:</span>
                          <span className="font-medium">{request.carrier?.companyName || request.carrier?.username || "—"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <MapPin className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Location:</span>
                          <span className="font-medium">{(request.carrier as any)?.location || "Not specified"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Phone className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Phone:</span>
                          <span className="font-medium">{request.carrier?.phone || "—"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Mail className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Email:</span>
                          <span className="font-medium">{(request.carrier as any)?.email || "—"}</span>
                        </div>
                      </div>
                    </div>
                    
                    <Separator />
                    
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Driver Details</p>
                      {assignedDriver ? (
                        <div className="grid grid-cols-1 gap-2 text-sm">
                          <div className="flex items-center gap-2">
                            <User className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Driver Name:</span>
                            <span className="font-medium">{assignedDriver.name}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Phone className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Driver Phone:</span>
                            <span className="font-medium">{assignedDriver.phone || "—"}</span>
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground italic">No driver assigned yet</p>
                      )}
                    </div>
                    
                    <Separator />
                    
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Truck Details</p>
                      {assignedTruck ? (
                        <div className="grid grid-cols-1 gap-2 text-sm">
                          <div className="flex items-center gap-2">
                            <Truck className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Truck Type:</span>
                            <span className="font-medium">{assignedTruck.truckType || "—"}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <MapPin className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Truck Location:</span>
                            <span className="font-medium">{(assignedTruck as any).truckLocation || "Not specified"}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-muted-foreground ml-6">License Plate:</span>
                            <span className="font-medium">{assignedTruck.licensePlate || assignedTruck.registrationNumber || "—"}</span>
                          </div>
                          {(assignedTruck.manufacturer || assignedTruck.model) && (
                            <div className="flex items-center gap-2">
                              <span className="text-muted-foreground ml-6">Vehicle:</span>
                              <span className="font-medium">{[assignedTruck.manufacturer, assignedTruck.model].filter(Boolean).join(" ") || "—"}</span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground italic">No truck assigned yet</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <Separator className="my-2" />
            </CollapsibleContent>
            
            <div className="flex gap-2 pt-2">
              <Button 
                size="sm" 
                onClick={() => onApprove(request.id)}
                data-testid={`button-approve-${request.id}`}
              >
                <CheckCircle className="h-4 w-4 mr-1" />
                Approve & Generate OTP
              </Button>
              <Button 
                size="sm" 
                variant="outline" 
                onClick={() => onReject(request.id)}
                data-testid={`button-reject-${request.id}`}
              >
                <XCircle className="h-4 w-4 mr-1" />
                Reject
              </Button>
            </div>
          </div>
        </CardContent>
      </Collapsible>
    </Card>
  );
}

interface ApprovedRequestCardProps {
  request: OtpRequest;
  onRegenerate: (id: string) => void;
}

function ApprovedRequestCard({ request, onRegenerate }: ApprovedRequestCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  
  const typeLabels: Record<string, string> = {
    trip_start: "Trip Start",
    route_start: "Route Start",
    trip_end: "Trip End",
    registration: "Registration"
  };
  const typeColors: Record<string, string> = {
    trip_start: "bg-green-500/10 text-green-600 dark:text-green-400",
    route_start: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    trip_end: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    registration: "bg-purple-500/10 text-purple-600 dark:text-purple-400"
  };
  const typeLabel = typeLabels[request.requestType] || "Unknown";
  const typeColor = typeColors[request.requestType] || "bg-muted text-muted-foreground";

  const isSoloDriver = (request as any).isSoloDriver;
  const assignedDriver = (request as any).assignedDriver;
  const assignedTruck = (request as any).assignedTruck;
  
  return (
    <Card className="mb-3" data-testid={`approved-request-${request.id}`}>
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CardContent className="pt-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge className={typeColor}>{typeLabel}</Badge>
                <Badge variant="outline">{formatLoadId(request.load)}</Badge>
                {isSoloDriver ? (
                  <Badge variant="secondary" className="text-xs">Solo Driver</Badge>
                ) : (
                  <Badge variant="secondary" className="text-xs">Enterprise</Badge>
                )}
              </div>
              <Badge variant="secondary">
                <CheckCircle className="h-3 w-3 mr-1" />
                Approved
              </Badge>
            </div>
            
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm">
                {isSoloDriver ? (
                  <User className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="font-medium">
                  {isSoloDriver 
                    ? ((request.carrier as any)?.driverName || request.carrier?.username || "Unknown Driver")
                    : (request.carrier?.companyName || request.carrier?.username || "Unknown Carrier")
                  }
                </span>
                {request.carrier?.phone && (
                  <span className="text-muted-foreground">
                    <Phone className="h-3 w-3 inline mr-1" />
                    {request.carrier.phone}
                  </span>
                )}
              </div>
              {request.load && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <MapPin className="h-4 w-4" />
                  <span>{request.load.pickupCity || "—"} → {request.load.deliveryCity || request.load.dropoffCity || "—"}</span>
                </div>
              )}
            </div>

            <CollapsibleTrigger asChild>
              <Button 
                variant="ghost" 
                size="sm" 
                className="w-full justify-center text-muted-foreground"
                data-testid={`button-expand-approved-${request.id}`}
              >
                {isExpanded ? (
                  <>
                    <ChevronUp className="h-4 w-4 mr-1" />
                    Hide Details
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-4 w-4 mr-1" />
                    View Driver Details
                  </>
                )}
              </Button>
            </CollapsibleTrigger>

            <CollapsibleContent>
              <Separator className="my-2" />
              <div className="space-y-3 py-2">
                {isSoloDriver ? (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Solo Driver Details</p>
                      <div className="grid grid-cols-1 gap-2 text-sm">
                        <div className="flex items-center gap-2">
                          <User className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Name:</span>
                          <span className="font-medium">{(request.carrier as any)?.driverName || request.carrier?.username || "—"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Phone className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Phone:</span>
                          <span className="font-medium">{request.carrier?.phone || "—"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <MapPin className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Location:</span>
                          <span className="font-medium">{(request.carrier as any)?.location || "Not specified"}</span>
                        </div>
                      </div>
                    </div>
                    
                    <Separator />
                    
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Truck Details</p>
                      {assignedTruck ? (
                        <div className="grid grid-cols-1 gap-2 text-sm">
                          <div className="flex items-center gap-2">
                            <Truck className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Truck Type:</span>
                            <span className="font-medium">{assignedTruck.truckType || "—"}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <MapPin className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Truck Location:</span>
                            <span className="font-medium">{(assignedTruck as any).truckLocation || "Not specified"}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-muted-foreground ml-6">License Plate:</span>
                            <span className="font-medium">{assignedTruck.licensePlate || assignedTruck.registrationNumber || "—"}</span>
                          </div>
                          {(assignedTruck.manufacturer || assignedTruck.model) && (
                            <div className="flex items-center gap-2">
                              <span className="text-muted-foreground ml-6">Vehicle:</span>
                              <span className="font-medium">{[assignedTruck.manufacturer, assignedTruck.model].filter(Boolean).join(" ") || "—"}</span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground italic">No truck assigned yet</p>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Enterprise Details</p>
                      <div className="grid grid-cols-1 gap-2 text-sm">
                        <div className="flex items-center gap-2">
                          <Building2 className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Company Name:</span>
                          <span className="font-medium">{request.carrier?.companyName || request.carrier?.username || "—"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <MapPin className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Location:</span>
                          <span className="font-medium">{(request.carrier as any)?.location || "Not specified"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Phone className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Phone:</span>
                          <span className="font-medium">{request.carrier?.phone || "—"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Mail className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Email:</span>
                          <span className="font-medium">{(request.carrier as any)?.email || "—"}</span>
                        </div>
                      </div>
                    </div>
                    
                    <Separator />
                    
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Driver Details</p>
                      {assignedDriver ? (
                        <div className="grid grid-cols-1 gap-2 text-sm">
                          <div className="flex items-center gap-2">
                            <User className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Driver Name:</span>
                            <span className="font-medium">{assignedDriver.name}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Phone className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Driver Phone:</span>
                            <span className="font-medium">{assignedDriver.phone || "—"}</span>
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground italic">No driver assigned yet</p>
                      )}
                    </div>
                    
                    <Separator />
                    
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Truck Details</p>
                      {assignedTruck ? (
                        <div className="grid grid-cols-1 gap-2 text-sm">
                          <div className="flex items-center gap-2">
                            <Truck className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Truck Type:</span>
                            <span className="font-medium">{assignedTruck.truckType || "—"}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <MapPin className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">Truck Location:</span>
                            <span className="font-medium">{(assignedTruck as any).truckLocation || "Not specified"}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-muted-foreground ml-6">License Plate:</span>
                            <span className="font-medium">{assignedTruck.licensePlate || assignedTruck.registrationNumber || "—"}</span>
                          </div>
                          {(assignedTruck.manufacturer || assignedTruck.model) && (
                            <div className="flex items-center gap-2">
                              <span className="text-muted-foreground ml-6">Vehicle:</span>
                              <span className="font-medium">{[assignedTruck.manufacturer, assignedTruck.model].filter(Boolean).join(" ") || "—"}</span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground italic">No truck assigned yet</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <Separator className="my-2" />
            </CollapsibleContent>
            
            <div className="flex items-center justify-between pt-2 border-t gap-4 flex-wrap">
              <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                <div>
                  <span className="font-medium">Requested:</span>{" "}
                  {request.requestedAt 
                    ? format(new Date(request.requestedAt), "MMM d, yyyy 'at' h:mm a")
                    : "—"}
                </div>
                <div>
                  <span className="font-medium">Approved:</span>{" "}
                  {request.processedAt 
                    ? format(new Date(request.processedAt), "MMM d, yyyy 'at' h:mm a")
                    : "—"}
                </div>
                {request.approvedBy && (
                  <div>
                    <span className="font-medium">By:</span> {request.approvedBy.username}
                  </div>
                )}
              </div>
              <Button 
                size="sm" 
                variant="outline"
                onClick={() => onRegenerate(request.id)}
                data-testid={`button-regenerate-${request.id}`}
              >
                <RefreshCw className="h-4 w-4 mr-1" />
                Regenerate OTP
              </Button>
            </div>
          </div>
        </CardContent>
      </Collapsible>
    </Card>
  );
}

export default function AdminOtpQueue() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [activeTab, setActiveTab] = useState("pending");
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState<OtpRequest | null>(null);
  const [rejectNotes, setRejectNotes] = useState("");
  const [validityMinutes, setValidityMinutes] = useState(10);
  const [generatedOtp, setGeneratedOtp] = useState<string | null>(null);
  const [showOtpDialog, setShowOtpDialog] = useState(false);

  const { data: requests, isLoading, refetch } = useOtpRequests();
  const approveMutation = useApproveOtpRequest();
  const rejectMutation = useRejectOtpRequest();
  const regenerateMutation = useRegenerateOtpRequest();

  const pendingRequests = (requests || []).filter(r => r.status === "pending");
  const approvedRequests = (requests || []).filter(r => r.status === "approved");
  const rejectedRequests = (requests || []).filter(r => r.status === "rejected");

  const handleApproveClick = (id: string) => {
    const request = requests?.find(r => r.id === id);
    if (request) {
      setSelectedRequest(request);
      setApproveDialogOpen(true);
    }
  };

  const handleRejectClick = (id: string) => {
    const request = requests?.find(r => r.id === id);
    if (request) {
      setSelectedRequest(request);
      setRejectNotes("");
      setRejectDialogOpen(true);
    }
  };

  const handleApproveConfirm = async () => {
    if (!selectedRequest) return;
    
    try {
      const result = await approveMutation.mutateAsync({
        requestId: selectedRequest.id,
        validityMinutes,
      });
      
      setApproveDialogOpen(false);
      setGeneratedOtp(result.otp.code);
      setShowOtpDialog(true);
      
      toast({
        title: "OTP Generated",
        description: "Share this OTP with the carrier via phone or message.",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to approve request",
        variant: "destructive",
      });
    }
  };

  const handleRejectConfirm = async () => {
    if (!selectedRequest) return;
    
    try {
      await rejectMutation.mutateAsync({
        requestId: selectedRequest.id,
        notes: rejectNotes,
      });
      
      setRejectDialogOpen(false);
      toast({
        title: "Request Rejected",
        description: "The carrier has been notified.",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to reject request",
        variant: "destructive",
      });
    }
  };

  const handleRegenerateClick = async (id: string) => {
    const request = requests?.find(r => r.id === id);
    if (!request) return;
    
    try {
      const result = await regenerateMutation.mutateAsync({
        requestId: id,
        validityMinutes: 10,
      });
      
      setGeneratedOtp(result.otp.code);
      setShowOtpDialog(true);
      
      toast({
        title: "OTP Regenerated",
        description: "A new OTP has been generated. Share it with the carrier.",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to regenerate OTP",
        variant: "destructive",
      });
    }
  };

  const copyOtpToClipboard = () => {
    if (generatedOtp) {
      navigator.clipboard.writeText(generatedOtp);
      toast({
        title: "Copied",
        description: "OTP copied to clipboard",
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="container py-6 max-w-4xl">
      <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Key className="h-6 w-6" />
            OTP Request Queue
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Review and approve carrier OTP requests for trip actions
          </p>
        </div>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={() => refetch()}
          data-testid="button-refresh-otp"
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="pending" data-testid="tab-pending">
            Pending
            {pendingRequests.length > 0 && (
              <Badge variant="destructive" className="ml-2">{pendingRequests.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="approved" data-testid="tab-approved">
            Approved
          </TabsTrigger>
          <TabsTrigger value="rejected" data-testid="tab-rejected">
            Rejected
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pending">
          {pendingRequests.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Key className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">No Pending Requests</h3>
                <p className="text-muted-foreground text-sm">
                  All OTP requests have been processed.
                </p>
              </CardContent>
            </Card>
          ) : (
            pendingRequests.map(request => (
              <OtpRequestCard
                key={request.id}
                request={request}
                onApprove={handleApproveClick}
                onReject={handleRejectClick}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="approved">
          {approvedRequests.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <CheckCircle className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">No approved requests yet.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground mb-4">
                Showing {approvedRequests.length} approved request{approvedRequests.length !== 1 ? 's' : ''}
              </p>
              {approvedRequests.map(request => (
                <ApprovedRequestCard key={request.id} request={request} onRegenerate={handleRegenerateClick} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="rejected">
          {rejectedRequests.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <XCircle className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">No rejected requests.</p>
              </CardContent>
            </Card>
          ) : (
            rejectedRequests.map(request => (
              <Card key={request.id} className="mb-3">
                <CardContent className="pt-4">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge className="bg-red-500/10 text-red-600">
                        {request.requestType === "trip_start" ? "Trip Start" : "Trip End"}
                      </Badge>
                      <Badge variant="outline">{formatLoadId(request.load)}</Badge>
                      <span className="text-sm text-muted-foreground">
                        {request.carrier?.companyName || request.carrier?.username}
                      </span>
                    </div>
                    <Badge variant="destructive">
                      <XCircle className="h-3 w-3 mr-1" />
                      Rejected
                    </Badge>
                  </div>
                  {request.notes && (
                    <p className="text-sm text-muted-foreground mt-2">Reason: {request.notes}</p>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={approveDialogOpen} onOpenChange={setApproveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve OTP Request</DialogTitle>
            <DialogDescription>
              Generate a one-time password for the carrier to start or end their trip.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Carrier</Label>
              <p className="text-sm font-medium">
                {selectedRequest?.carrier?.companyName || selectedRequest?.carrier?.username}
              </p>
            </div>
            <div className="space-y-2">
              <Label>Route</Label>
              <p className="text-sm">
                {selectedRequest?.load?.pickupCity || "—"} → {selectedRequest?.load?.deliveryCity || "—"}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="validity">OTP Validity (minutes)</Label>
              <Input
                id="validity"
                type="number"
                min={5}
                max={60}
                value={validityMinutes}
                onChange={(e) => setValidityMinutes(parseInt(e.target.value) || 10)}
                data-testid="input-validity-minutes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleApproveConfirm} 
              disabled={approveMutation.isPending}
              data-testid="button-confirm-approve"
            >
              {approveMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Key className="h-4 w-4 mr-2" />
              )}
              Generate OTP
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject OTP Request</DialogTitle>
            <DialogDescription>
              Provide a reason for rejecting this OTP request. The carrier will be notified.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="reject-notes">Reason (optional)</Label>
              <Textarea
                id="reject-notes"
                placeholder=""
                value={rejectNotes}
                onChange={(e) => setRejectNotes(e.target.value)}
                data-testid="input-reject-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              variant="destructive"
              onClick={handleRejectConfirm} 
              disabled={rejectMutation.isPending}
              data-testid="button-confirm-reject"
            >
              {rejectMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <XCircle className="h-4 w-4 mr-2" />
              )}
              Reject Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showOtpDialog} onOpenChange={setShowOtpDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-600" />
              OTP Generated Successfully
            </DialogTitle>
            <DialogDescription>
              Share this OTP with the carrier through a secure channel (phone call or SMS).
            </DialogDescription>
          </DialogHeader>
          <div className="py-6">
            <div className="bg-muted rounded-lg p-6 text-center">
              <p className="text-sm text-muted-foreground mb-2">One-Time Password</p>
              <p className="text-4xl font-mono font-bold tracking-[0.5em]" data-testid="text-generated-otp">
                {generatedOtp}
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                Valid for {validityMinutes} minutes
              </p>
            </div>
            <div className="flex justify-center gap-2 mt-4">
              <Button variant="outline" size="sm" onClick={copyOtpToClipboard}>
                <Copy className="h-4 w-4 mr-2" />
                Copy OTP
              </Button>
            </div>
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <div className="flex gap-2 flex-1 justify-start text-muted-foreground text-sm items-center">
              <Phone className="h-4 w-4" />
              <span>Call or message the carrier to share this OTP</span>
            </div>
            <Button onClick={() => setShowOtpDialog(false)} data-testid="button-close-otp-dialog">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
