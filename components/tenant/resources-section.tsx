"use client";

import { NetworkIcon } from "lucide-react";

import { renderBadgeList } from "@/components/dashboard/format";
import { Badge } from "@/components/ui/badge";
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
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type {
  PublicTenant,
  TenantResources,
} from "@/src/shared/types/entities";

export function TenantResourcesSection({
  resources,
  tenant,
}: {
  resources: TenantResources;
  tenant: PublicTenant;
}) {
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>授权模型</CardTitle>
          <CardDescription>Key 可从这些模型中选择更小子集。</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg bg-muted/35 p-3">
            {renderBadgeList(resources.models, "管理员未限制模型")}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>授权通道</CardTitle>
          <CardDescription>Key 可从这些通道中选择更小子集。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {resources.channels.length === 0 ? (
            <Empty className="col-span-full min-h-44">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <NetworkIcon />
                </EmptyMedia>
                <EmptyTitle>暂无授权通道</EmptyTitle>
                <EmptyDescription>
                  {tenant.channelAllowlist.length === 0
                    ? "管理员未限制通道。"
                    : "暂无可用授权通道。"}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            resources.channels.map((channel) => (
              <div
                key={channel.id}
                className="rounded-lg border bg-background/60 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{channel.name}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {channel.id}
                    </div>
                  </div>
                  <Badge variant={channel.enabled ? "secondary" : "outline"}>
                    {channel.status}
                  </Badge>
                </div>
                <div className="mt-3 text-xs text-muted-foreground">
                  {renderBadgeList(channel.modelAllowlist, "全部模型")}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
