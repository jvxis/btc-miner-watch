import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * O exceljs usa require dinamico, e com ele dentro do bundle o rastreador
   * do Next conclui que precisa do projeto inteiro — o build avisa que tracou
   * tudo sem querer. Externo, o Node carrega por require normal.
   */
  serverExternalPackages: ['exceljs'],
  /* config options here */
};

export default nextConfig;
