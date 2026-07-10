"use client";

import { RequestLogsWorkbench } from "@/components/workspace/request-logs-workbench";
import type { RequestLogsPage } from "@/lib/admin-api";
import {
  getTenantRequestLogDetail,
  getTenantRequestLogsPage,
  tenantErrorMessage,
} from "@/lib/tenant-api";

export function TenantLogsSection({
  initialPage,
  onLoaded,
}: {
  initialPage: RequestLogsPage;
  onLoaded: (page: RequestLogsPage) => void;
}) {
  return (
    <RequestLogsWorkbench
      detailTenantColumn={false}
      errorMessage={tenantErrorMessage}
      initialPage={initialPage}
      loadDetail={getTenantRequestLogDetail}
      loadPage={getTenantRequestLogsPage}
      onLoaded={onLoaded}
    />
  );
}
