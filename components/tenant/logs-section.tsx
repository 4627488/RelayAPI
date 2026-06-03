"use client";

import * as React from "react";
import { RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";

import {
  formatDateTime,
  formatTokenNumber,
} from "@/components/dashboard/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  AdminDashboardRequestLogRow,
  RequestLogsPage,
} from "@/lib/admin-api";
import {
  getTenantRequestLogsPage,
  tenantErrorMessage,
} from "@/lib/tenant-api";

export function TenantLogsSection({
  initialPage,
  logs,
  onLoaded,
}: {
  initialPage: RequestLogsPage;
  logs: AdminDashboardRequestLogRow[];
  onLoaded: (logs: AdminDashboardRequestLogRow[]) => void;
}) {
  const [loading, setLoading] = React.useState(false);
  const didAutoLoadRef = React.useRef(false);

  async function load() {
    setLoading(true);
    try {
      const page = await getTenantRequestLogsPage({
        limit: initialPage.limit,
        page: 1,
      });
      onLoaded(page.data);
      toast.success("日志已刷新");
    } catch (error) {
      toast.error(tenantErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    if (didAutoLoadRef.current) {
      return;
    }
    if (
      initialPage.data.length > 0 ||
      initialPage.total > 0 ||
      logs.length > 0
    ) {
      return;
    }
    didAutoLoadRef.current = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      getTenantRequestLogsPage({
        limit: initialPage.limit,
        page: 1,
      })
        .then((page) => {
          onLoaded(page.data);
        })
        .catch((error) => {
          toast.error(tenantErrorMessage(error));
        })
        .finally(() => {
          setLoading(false);
        });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [
    initialPage.data.length,
    initialPage.limit,
    initialPage.total,
    logs.length,
    onLoaded,
  ]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>请求日志</CardTitle>
          <CardDescription>仅包含当前租户 Key 发起的请求。</CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={loading}
          onClick={load}
        >
          {loading ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" />
          )}
          刷新
        </Button>
      </CardHeader>
      <CardContent>
        {loading && logs.length === 0 ? (
          <div className="flex min-h-64 items-center justify-center gap-2 rounded-lg border bg-muted/20 text-sm text-muted-foreground">
            <Spinner />
            正在加载请求日志
          </div>
        ) : logs.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>暂无请求日志</EmptyTitle>
              <EmptyDescription>当租户 Key 产生请求后会显示在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">Token</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell>{formatDateTime(log.started_at)}</TableCell>
                  <TableCell>
                    {log.api_key_name || log.api_key_prefix || "未知 Key"}
                  </TableCell>
                  <TableCell>{log.model || "未记录"}</TableCell>
                  <TableCell>
                    <Badge
                      variant={log.status_code >= 400 ? "destructive" : "secondary"}
                    >
                      {log.status_code}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatTokenNumber(log.total_tokens)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
