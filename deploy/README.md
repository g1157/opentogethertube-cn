# 部署配置

简体中文分支的构建、独立 18080 验收、同镜像切换 8080 和回退步骤见 [DEPLOYMENT.md](../DEPLOYMENT.md)。

-   [next-compose.yml](next-compose.yml)：应用、PostgreSQL 和 Redis 的独立实例配置。
-   [next.Dockerfile](next.Dockerfile)：打包已经编译的应用与对应源码归档。
-   [.env.example](.env.example)：独立验收实例的参数示例，部署密钥留空。
-   [next-backup.sh](next-backup.sh)：PostgreSQL 备份脚本。

其余 Fly、Ansible 和 Kubernetes 等配置保留自官方上游，供基础设施开发参考；本分支的 Compose
部署不使用其中的上游服务名称或发布目标。
