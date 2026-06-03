"use client";

import { KeyRoundIcon, PencilIcon, Trash2Icon } from "lucide-react";

import { renderBadgeList } from "@/components/dashboard/format";
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
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  PublicApiKey,
  TenantResources,
} from "@/src/shared/types/entities";

export function TenantApiKeysSection({
  apiKeys,
  resources,
  onCreate,
  onDelete,
  onEdit,
}: {
  apiKeys: PublicApiKey[];
  resources: TenantResources;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onEdit: (apiKey: PublicApiKey) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>API 密钥</CardTitle>
          <CardDescription>租户 Key 只能使用已授权的模型和通道。</CardDescription>
        </div>
        <Button type="button" onClick={onCreate}>
          <KeyRoundIcon data-icon="inline-start" />
          新建 Key
        </Button>
      </CardHeader>
      <CardContent>
        {apiKeys.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <KeyRoundIcon />
              </EmptyMedia>
              <EmptyTitle>暂无 API 密钥</EmptyTitle>
              <EmptyDescription>创建第一个 Key 后即可接入 Relay。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>前缀</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>通道</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apiKeys.map((apiKey) => (
                <TableRow key={apiKey.id}>
                  <TableCell className="font-medium">{apiKey.name}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {apiKey.prefix}
                  </TableCell>
                  <TableCell>
                    {renderBadgeList(apiKey.modelAllowlist, "全部授权模型")}
                  </TableCell>
                  <TableCell>
                    {renderBadgeList(
                      apiKey.channelAllowlist.map(
                        (id) =>
                          resources.channels.find((channel) => channel.id === id)
                            ?.name || id,
                      ),
                      "全部授权通道",
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={apiKey.enabled ? "secondary" : "outline"}>
                      {apiKey.enabled ? "启用" : "停用"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => onEdit(apiKey)}
                        aria-label="编辑 API 密钥"
                      >
                        <PencilIcon />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => onDelete(apiKey.id)}
                        aria-label="删除 API 密钥"
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
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
