# Nodejs Guardian

This utility allows to take cpu profiles or heap snapshots of nodejs process running in a kubernetes pod (must be the PID 1 process).

## Usage

You can configure cpu or memory usage thresholds and the utility will start taking cpu profiles or snapshot when the threshold is reached.

The thresholds can be evaluated either against the k8s metrics API or the nodejs process itself, the last method is more accurate since k8s metrics are aggregated and can be delayed.

**Examples**:

Getting help:
```bash
docker run --rm node:alpine npx nodejs-guardian --help
```

Taking a cpu profile of 1 second when the cpu usage is greater than 800m using direct measurement of cpu usage:
```bash
docker run --r node:alpine npx nodejs-guardian -n default -s my-service -c container --cpu 1 --hcpu 800 --noMetrics
```

Taking a cpu profile of 1 second and a heap profile of 5 seconds when the memory usage is greater than 80Mi using direct measurement of memory usage:
```bash
docker run --rm node:alpine npx nodejs-guardian -n default -s my-service -c container --cpu 1 --heap 5  -hmem 80 --noMetrics
```
