import { useState, useMemo } from "react";
import { 
  AreaChart, 
  Area, 
  LineChart,
  Line,
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  ReferenceDot,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { 
  TrendingUp, 
  TrendingDown, 
  Download, 
  Maximize2,
  X,
  Calendar,
  Package,
  Users,
  DollarSign,
  MapPin,
  FileDown,
} from "lucide-react";
import { useTheme } from "@/lib/theme-provider";

interface MonthlyData {
  month: string;
  fullMonth: string;
  volume: number;
  activeLoads: number;
  carrierSignups: number;
  revenue: number;
  completedLoads: number;
  avgLoadPrice: number;
  topRoutes: { route: string; count: number }[];
}

const generateMockData = (): MonthlyData[] => {
  const months = [
    { short: "Jan", full: "January 2024" },
    { short: "Feb", full: "February 2024" },
    { short: "Mar", full: "March 2024" },
    { short: "Apr", full: "April 2024" },
    { short: "May", full: "May 2024" },
    { short: "Jun", full: "June 2024" },
    { short: "Jul", full: "July 2024" },
    { short: "Aug", full: "August 2024" },
    { short: "Sep", full: "September 2024" },
    { short: "Oct", full: "October 2024" },
    { short: "Nov", full: "November 2024" },
    { short: "Dec", full: "December 2024" },
  ];

  const routes = [
    "Mumbai - Pune",
    "Delhi - Jaipur",
    "Bangalore - Chennai",
    "Ahmedabad - Surat",
    "Kolkata - Patna",
    "Hyderabad - Visakhapatnam",
    "Lucknow - Kanpur",
  ];

  return months.map((m, i) => {
    const baseVolume = 1500000 + Math.random() * 1000000 + (i * 80000);
    const shuffledRoutes = [...routes].sort(() => Math.random() - 0.5);
    
    return {
      month: m.short,
      fullMonth: m.full,
      volume: Math.round(baseVolume),
      activeLoads: Math.round(200 + Math.random() * 150 + (i * 12)),
      carrierSignups: Math.round(30 + Math.random() * 25 + (i * 3)),
      revenue: Math.round(baseVolume * 0.12),
      completedLoads: Math.round(180 + Math.random() * 100 + (i * 10)),
      avgLoadPrice: Math.round(2200 + Math.random() * 800),
      topRoutes: shuffledRoutes.slice(0, 5).map((route, idx) => ({
        route,
        count: Math.round(50 - idx * 8 + Math.random() * 10),
      })),
    };
  });
};

const fullYearData = generateMockData();

type TimeRange = "3m" | "6m" | "1y" | "custom";
type MetricType = "volume" | "activeLoads" | "carrierSignups" | "revenue";

const metricConfig: Record<MetricType, { label: string; formatter: (v: number) => string; icon: typeof DollarSign }> = {
  volume: { 
    label: "Transaction Volume", 
    formatter: (v) => `Rs. ${(v / 100000).toFixed(1)}L`,
    icon: DollarSign,
  },
  activeLoads: { 
    label: "All Loads", 
    formatter: (v) => v.toLocaleString(),
    icon: Package,
  },
  carrierSignups: { 
    label: "Carrier Signups", 
    formatter: (v) => v.toLocaleString(),
    icon: Users,
  },
  revenue: { 
    label: "Revenue", 
    formatter: (v) => `Rs. ${(v / 100000).toFixed(1)}L`,
    icon: DollarSign,
  },
};

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: MonthlyData; value: number }>;
  label?: string;
  metric: MetricType;
  previousValue?: number;
}

function CustomTooltip({ active, payload, metric, previousValue }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;

  const data = payload[0].payload;
  const currentValue = data[metric];
  const growth = previousValue ? ((currentValue - previousValue) / previousValue * 100) : 0;
  const isPositive = growth >= 0;

  return (
    <div className="bg-card border border-border rounded-lg shadow-xl p-3 min-w-[180px]">
      <div className="font-semibold text-foreground mb-2">{data.fullMonth}</div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground text-sm">{metricConfig[metric].label}</span>
          <span className="font-mono font-semibold text-foreground">
            {metricConfig[metric].formatter(currentValue)}
          </span>
        </div>
        {previousValue !== undefined && (
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground text-sm">Growth</span>
            <div className={`flex items-center gap-1 font-medium ${isPositive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
              {isPositive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              <span>{isPositive ? "+" : ""}{growth.toFixed(1)}%</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface MonthDetailPanelProps {
  data: MonthlyData | null;
  onClose: () => void;
  previousData?: MonthlyData;
}

function MonthDetailPanel({ data, onClose, previousData }: MonthDetailPanelProps) {
  if (!data) return null;

  const volumeGrowth = previousData 
    ? ((data.volume - previousData.volume) / previousData.volume * 100) 
    : 0;
  const isPositive = volumeGrowth >= 0;

  return (
    <div className="bg-card border-l border-border p-4 min-w-[280px] max-w-[320px] overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-lg">{data.fullMonth}</h3>
        <Button 
          size="icon" 
          variant="ghost" 
          onClick={onClose}
          data-testid="button-close-month-detail"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Transaction Volume</span>
            <span className="font-mono font-semibold">Rs. {(data.volume / 100000).toFixed(1)}L</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Completed Loads</span>
            <span className="font-mono font-semibold">{data.completedLoads}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Avg Load Price</span>
            <span className="font-mono font-semibold">Rs. {data.avgLoadPrice.toLocaleString()}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Growth</span>
            <div className={`flex items-center gap-1 font-semibold ${isPositive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
              {isPositive ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
              {isPositive ? "+" : ""}{volumeGrowth.toFixed(1)}%
            </div>
          </div>
        </div>

        <div className="border-t border-border pt-4">
          <div className="flex items-center gap-2 mb-3">
            <MapPin className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">Top 5 Routes</span>
          </div>
          <div className="space-y-2">
            {data.topRoutes.map((route, idx) => (
              <div key={idx} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground truncate mr-2">{route.route}</span>
                <Badge variant="secondary" className="no-default-hover-elevate no-default-active-elevate text-xs">
                  {route.count} loads
                </Badge>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function TransactionVolumeChart() {
  const { theme } = useTheme();
  const [timeRange, setTimeRange] = useState<TimeRange>("1y");
  const [metric, setMetric] = useState<MetricType>("volume");
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState<MonthlyData | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const filteredData = useMemo(() => {
    switch (timeRange) {
      case "3m":
        return fullYearData.slice(-3);
      case "6m":
        return fullYearData.slice(-6);
      case "1y":
      case "custom":
      default:
        return fullYearData;
    }
  }, [timeRange]);

  const currentValue = filteredData[filteredData.length - 1]?.[metric] ?? 0;
  const previousValue = filteredData[filteredData.length - 2]?.[metric] ?? currentValue;
  const monthlyGrowth = previousValue ? ((currentValue - previousValue) / previousValue * 100) : 0;
  const isGrowthPositive = monthlyGrowth >= 0;

  const chartColors = {
    stroke: theme === "dark" ? "hsl(217, 91%, 65%)" : "hsl(217, 91%, 48%)",
    fill: theme === "dark" ? "hsl(217, 91%, 65%)" : "hsl(217, 91%, 48%)",
  };

  const handleExportCSV = () => {
    const headers = ["Month", "Volume", "All Loads", "Carrier Signups", "Revenue", "Completed Loads", "Avg Load Price"];
    const csvContent = [
      headers.join(","),
      ...filteredData.map(d => [
        d.fullMonth,
        d.volume,
        d.activeLoads,
        d.carrierSignups,
        d.revenue,
        d.completedLoads,
        d.avgLoadPrice,
      ].join(","))
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "transaction-volume-report.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleExportPDF = () => {
    alert("PDF export would be generated here. In production, this would use a library like jspdf or call a backend service.");
  };

  const handleChartClick = (data: { activePayload?: Array<{ payload: MonthlyData }> } | null) => {
    if (data?.activePayload?.[0]) {
      setSelectedMonth(data.activePayload[0].payload);
    }
  };

  const handleDotClick = (data: MonthlyData) => {
    setSelectedMonth(data);
  };

  const getYAxisFormatter = (value: number) => {
    if (metric === "volume" || metric === "revenue") {
      return `Rs. ${(value / 100000).toFixed(1)}L`;
    }
    return value.toString();
  };

  const renderChart = (height: number, showDots = false) => (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart 
        data={filteredData}
        onClick={handleChartClick}
        onMouseMove={(e) => {
          if (e?.activeTooltipIndex !== undefined) {
            setHoveredIndex(e.activeTooltipIndex);
          }
        }}
        onMouseLeave={() => setHoveredIndex(null)}
        style={{ cursor: "pointer" }}
        margin={{ top: 10, right: 10, left: 20, bottom: 0 }}
      >
        <defs>
          <linearGradient id="colorMetric" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={chartColors.fill} stopOpacity={0.3} />
            <stop offset="95%" stopColor={chartColors.fill} stopOpacity={0.05} />
          </linearGradient>
          <linearGradient id="colorMetricExpanded" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={chartColors.fill} stopOpacity={0.4} />
            <stop offset="95%" stopColor={chartColors.fill} stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid 
          strokeDasharray="3 3" 
          stroke={theme === "dark" ? "hsl(220, 12%, 18%)" : "hsl(220, 12%, 92%)"} 
          vertical={false}
        />
        <XAxis 
          dataKey="month" 
          axisLine={false}
          tickLine={false}
          tick={{ fill: theme === "dark" ? "hsl(220, 10%, 65%)" : "hsl(220, 12%, 35%)", fontSize: 12 }}
          dy={10}
        />
        <YAxis 
          axisLine={false}
          tickLine={false}
          tick={{ fill: theme === "dark" ? "hsl(220, 10%, 65%)" : "hsl(220, 12%, 35%)", fontSize: 12 }}
          tickFormatter={getYAxisFormatter}
          dx={-10}
        />
        <Tooltip 
          content={
            <CustomTooltip 
              metric={metric} 
              previousValue={hoveredIndex !== null && hoveredIndex > 0 ? filteredData[hoveredIndex - 1]?.[metric] : undefined}
            />
          }
          cursor={{ 
            stroke: theme === "dark" ? "hsl(220, 12%, 25%)" : "hsl(220, 12%, 85%)",
            strokeWidth: 1,
            strokeDasharray: "4 4",
          }}
        />
        <Area
          type="monotone"
          dataKey={metric}
          stroke={chartColors.stroke}
          fillOpacity={1}
          fill={isExpanded ? "url(#colorMetricExpanded)" : "url(#colorMetric)"}
          strokeWidth={2}
          dot={showDots ? { 
            fill: chartColors.fill, 
            stroke: theme === "dark" ? "hsl(220, 15%, 8%)" : "white",
            strokeWidth: 2,
            r: 5,
            cursor: "pointer",
            onClick: (e: any, payload: any) => {
              e.stopPropagation?.();
              if (payload?.payload) {
                handleDotClick(payload.payload);
              }
            },
          } : false}
          activeDot={{
            fill: chartColors.fill,
            stroke: theme === "dark" ? "hsl(220, 15%, 8%)" : "white",
            strokeWidth: 2,
            r: 6,
            cursor: "pointer",
            onClick: (e: any, payload: any) => {
              if (payload?.payload) {
                handleDotClick(payload.payload);
              }
            },
          }}
          animationDuration={500}
          animationEasing="ease-out"
        />
      </AreaChart>
    </ResponsiveContainer>
  );

  const selectedIndex = selectedMonth ? filteredData.findIndex(d => d.month === selectedMonth.month) : -1;
  const previousMonthData = selectedIndex > 0 ? filteredData[selectedIndex - 1] : undefined;

  return (
    <>
      <Card 
        className="lg:col-span-2 cursor-pointer transition-shadow hover:shadow-md"
        onClick={() => setIsExpanded(true)}
        data-testid="card-transaction-volume"
      >
        <CardHeader className="flex flex-row items-center justify-between gap-4 pb-4 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <CardTitle className="text-lg">Transaction Volume</CardTitle>
            <Badge 
              variant="secondary" 
              className={`no-default-hover-elevate no-default-active-elevate ${isGrowthPositive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
            >
              {isGrowthPositive ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
              {isGrowthPositive ? "+" : ""}{monthlyGrowth.toFixed(1)}% vs last month
            </Badge>
          </div>
          <Button 
            size="icon" 
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(true);
            }}
            data-testid="button-expand-chart"
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <div className="h-64" data-testid="chart-transaction-volume">
            {renderChart(256)}
          </div>
          <p className="text-xs text-muted-foreground mt-3 text-center">
            Click anywhere on the chart to view detailed analytics
          </p>
        </CardContent>
      </Card>

      <Dialog open={isExpanded} onOpenChange={setIsExpanded}>
        <DialogContent className="max-w-6xl w-[95vw] max-h-[90vh] p-0 gap-0 overflow-hidden">
          <DialogHeader className="p-6 pb-0">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <DialogTitle className="text-xl">Transaction Volume Analytics</DialogTitle>
                <DialogDescription>
                  Full year overview with detailed metrics and trends
                </DialogDescription>
              </div>
              <Badge 
                variant="secondary" 
                className={`no-default-hover-elevate no-default-active-elevate ${isGrowthPositive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
              >
                {isGrowthPositive ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                {isGrowthPositive ? "+" : ""}{monthlyGrowth.toFixed(1)}% vs last month
              </Badge>
            </div>
          </DialogHeader>

          <div className="p-6 pt-4 space-y-4 overflow-y-auto">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <Select value={timeRange} onValueChange={(v) => setTimeRange(v as TimeRange)}>
                  <SelectTrigger className="w-[160px]" data-testid="select-time-range">
                    <Calendar className="h-4 w-4 mr-2 text-muted-foreground" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="3m">Last 3 Months</SelectItem>
                    <SelectItem value="6m">Last 6 Months</SelectItem>
                    <SelectItem value="1y">1 Year</SelectItem>
                    <SelectItem value="custom">Custom Range</SelectItem>
                  </SelectContent>
                </Select>

                <Select value={metric} onValueChange={(v) => setMetric(v as MetricType)}>
                  <SelectTrigger className="w-[200px]" data-testid="select-metric-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="volume">Transaction Volume</SelectItem>
                    <SelectItem value="activeLoads">All Loads</SelectItem>
                    <SelectItem value="carrierSignups">Carrier Signups</SelectItem>
                    <SelectItem value="revenue">Revenue</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-2">
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={handleExportCSV}
                  data-testid="button-export-csv"
                >
                  <FileDown className="h-4 w-4 mr-2" />
                  CSV
                </Button>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={handleExportPDF}
                  data-testid="button-export-pdf"
                >
                  <Download className="h-4 w-4 mr-2" />
                  PDF
                </Button>
              </div>
            </div>

            <div className="flex gap-0 border border-border rounded-lg overflow-hidden">
              <div className={`flex-1 p-4 ${selectedMonth ? "pr-0" : ""}`}>
                <div className="h-[350px]" data-testid="chart-expanded-view">
                  {renderChart(350, true)}
                </div>
              </div>

              {selectedMonth && (
                <MonthDetailPanel 
                  data={selectedMonth}
                  previousData={previousMonthData}
                  onClose={() => setSelectedMonth(null)}
                />
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="bg-muted/50 rounded-lg p-4">
                <div className="text-muted-foreground text-sm mb-1">Total Volume (YTD)</div>
                <div className="text-2xl font-bold font-mono">
                  Rs. {(fullYearData.reduce((sum, d) => sum + d.volume, 0) / 10000000).toFixed(1)}Cr
                </div>
              </div>
              <div className="bg-muted/50 rounded-lg p-4">
                <div className="text-muted-foreground text-sm mb-1">Avg Monthly Volume</div>
                <div className="text-2xl font-bold font-mono">
                  Rs. {(fullYearData.reduce((sum, d) => sum + d.volume, 0) / fullYearData.length / 100000).toFixed(1)}L
                </div>
              </div>
              <div className="bg-muted/50 rounded-lg p-4">
                <div className="text-muted-foreground text-sm mb-1">Total Completed Loads</div>
                <div className="text-2xl font-bold font-mono">
                  {fullYearData.reduce((sum, d) => sum + d.completedLoads, 0).toLocaleString()}
                </div>
              </div>
              <div className="bg-muted/50 rounded-lg p-4">
                <div className="text-muted-foreground text-sm mb-1">Avg Load Price</div>
                <div className="text-2xl font-bold font-mono">
                  Rs. {Math.round(fullYearData.reduce((sum, d) => sum + d.avgLoadPrice, 0) / fullYearData.length).toLocaleString()}
                </div>
              </div>
            </div>

            <p className="text-sm text-muted-foreground text-center">
              Click on any data point in the chart to view detailed monthly metrics
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
