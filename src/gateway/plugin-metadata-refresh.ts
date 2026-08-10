export type GatewayPluginMetadataRefreshResult = Readonly<{
  committed: true;
  generation: number;
}>;

export type GatewayPluginMetadataRefresh = () => Promise<GatewayPluginMetadataRefreshResult>;
