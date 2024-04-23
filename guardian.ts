import { AddressInfo, WebSocket } from "ws";
import { Readable, Writable } from "stream";
import * as http from "http";
import * as fs from "fs";
import * as net from "net";
import * as k8s from "@kubernetes/client-node";
import yargs from "yargs";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const watch = new k8s.Watch(kc);
const exec = new k8s.Exec(kc);
const metrics = new k8s.Metrics(kc);
const portforward = new k8s.PortForward(kc);


const argv = yargs
  .option('namespace', {
    alias: 'n',
    description: 'Namespace of the namespace'
  })
  .option('service', {
    alias: 's',
    description: 'Name of the service',
    demandOption: true,
  })
  .option('container', {
    alias: 'c',
    description: 'Name of the container of pods running the service',
    demandOption: true,
  })
  .option('cpuProfiling', {
    alias: 'cpu',
    description: 'Enable CPU profiling for the given amount of seconds',
    type: 'number'
  })
  .option('heapProfiling', {
    alias: 'heap',
    description: 'Enable Heap profiling for the given amount of seconds',
    type: 'number'
  })
  .option('highCpuWatermarkMilli', {
    alias: 'hcpu',
    description: 'High CPU watermark in millicores to trigger profiling',
    type: 'number'
  })
  .option('highMemoryWatermarkMi', {
    alias: 'hmem',
    description: 'High memory watermark in Mibibytes to trigger profiling',
    type: 'number'
  })
  .option('metricsPollInterval', {
    alias: 'i',
    description: 'Metrics poll interval in seconds',
    default: 5,
    type: 'number'
  })
  .option('noMetrics', {
    description: 'Don\'t use metrics api to get cpu and memory usage, use exec instead'
  })
  .option('delayBetweenProfiles', {
    alias: 'd',
    description: 'Delay between profiles in seconds',
    default: 60,
    type: 'number'
  })
  .count('noMetrics')
  .help()
  .alias('help', 'h')
  .argv;



const serviceName = (argv as any).service;
const container = (argv as any).container;
const namespace = (argv as any).namespace || kc.getContextObject(kc.getCurrentContext())?.namespace;
const cpuProfiling = (argv as any).cpuProfiling;
const heapProfiling = (argv as any).heapProfiling;
const highCpuWatermarkMilli = (argv as any).highCpuWatermarkMilli;
const highMemoryWatermarkMi = (argv as any).highMemoryWatermarkMi;
const noMetrics = (argv as any).noMetrics > 0;
const metricsPollInterval = (argv as any).metricsPollInterval;
const delayBetweenProfiles = (argv as any).delayBetweenProfiles;

if (!highCpuWatermarkMilli && !highMemoryWatermarkMi) {
  console.error("High CPU or memory watermark must be set");
  process.exit(1);
}

class NodeGuardian {
  pod: string;
  host: string;
  running: boolean;

  constructor(pod: string, host: string) {
    this.pod = pod;
    this.host = host;
    this.running = true;
    console.log(`[${this.pod}] Starting guardian`);
    this.guard();
  }

  stop() {
    console.log(`[${this.pod}] Stopping guardian`);
    this.running = false;
  }

  async getMemoryUsage() : Promise<number> {
    let usage = 0;
    try {
      const command = ["cat", "/proc/1/statm"];

      let data = '';
    
      const writableStream = new Writable({
        write(chunk, encoding, callback) {
          data += chunk.toString();
          callback();
        }
      });

      const stream = await exec.exec(
        namespace,
        this.pod,
        container,
        command,
        writableStream,
        process.stderr,
        new Readable({ read() {}}),
        true /* tty */
      );

      // await stream gets closed
      await new Promise((resolve) => {
        stream.on("close", resolve);
      });

      const fields = data.toString().trim().split(/\s+/);
      const rssPages = Number(fields[1]);
      // FIXME: assume 4KiB page size
      const rssKiB = rssPages * 4 / 1024; // Convert pages to MiB
      return rssKiB; 
    } catch (err) {
      console.error(`Error: ${err}`);
    }
    return usage;
  }

  async getCpuUsage(): Promise<number> {
    const command = ["cat", "/proc/1/stat"];


    let data1 = '';
    let data2 = '';
  
    const writableStream1 = new Writable({
      write(chunk, encoding, callback) {
        data1 += chunk.toString();
        callback();
      }
    });

    const writableStream2 = new Writable({
      write(chunk, encoding, callback) {
        data2 += chunk.toString();
        callback();
      }
    });

    // create a writable stream to capture the output

    const stream1 = await exec.exec(
      namespace,
      this.pod,
      container,
      command,
      writableStream1,
      process.stderr,
      new Readable({ read() {}}),
      true /* tty */
    );

    // await stream1 gets closed
    await new Promise((resolve) => {
      stream1.on("close", resolve);
    });

    const startTime = performance.now();
    const utime1 = Number(data1.toString().split(' ')[13]);
    const stime1 = Number(data1.toString().split(' ')[14]);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const stream2 = await exec.exec(
      namespace,
      this.pod,
      container,
      command,
      writableStream2,
      process.stderr,
      new Readable({ read() {}}),
      true /* tty */
    );

    // await stream2 gets closed
    await new Promise((resolve) => {
      stream2.on("close", resolve);
    });

    const endTime = performance.now();
    const utime2 = Number(data2.toString().split(' ')[13]);
    const stime2 = Number(data2.toString().split(' ')[14]);

    // FIXME: is assuming 100ms tick time (getconfig CLK_TCK)
    const cpuUsage = ((utime2 - utime1 + stime2 - stime1) / ( 10*(endTime - startTime) ) ) * 100000; // CPU usage as a percentage
    return cpuUsage;
  }

  async getPodUsageExec() {
    let cpuUsage = 0;
    let memoryUsage = 0;
    if (highCpuWatermarkMilli) {
      cpuUsage = await this.getCpuUsage();
      console.log(`[${this.pod}] CPU usage: ${cpuUsage}m / ${highCpuWatermarkMilli}m`);
    }
    if (highMemoryWatermarkMi) {
      memoryUsage = await this.getMemoryUsage();
      console.log(`[${this.pod}] Memory usage: ${memoryUsage}MiB / ${highMemoryWatermarkMi}MiB`);
    }
  }

  async getPodUsage() {
    try {
      let cpuUsage = 0;
      let memoryUsage = 0;
      if (noMetrics) {
        if (highCpuWatermarkMilli) {
          cpuUsage = await this.getCpuUsage();
        }
        if (highMemoryWatermarkMi) {
          memoryUsage = await this.getMemoryUsage();
        }
      } else {
        const podMetrics = await metrics.getPodMetrics(namespace, this.pod);
        const podContainer = podMetrics.containers.find((c) => c.name == container);
        if (!podContainer) {
          throw `[${this.pod}] Could not find container ${container} in pod metrics `
        }
        cpuUsage = parseInt(podContainer.usage.cpu) / 1000000;
        memoryUsage = parseInt(podContainer.usage.memory) / 1024;
      }
      if (highCpuWatermarkMilli) {
        console.log(`[${this.pod}] CPU usage: ${cpuUsage}m / ${highCpuWatermarkMilli}m`);
      }

      if (highMemoryWatermarkMi) {
        console.log(`[${this.pod}] Memory usage: ${memoryUsage}MiB / ${highMemoryWatermarkMi}MiB`);
      }

      if (
        (highCpuWatermarkMilli && cpuUsage > highCpuWatermarkMilli) ||
        (highMemoryWatermarkMi && memoryUsage > highMemoryWatermarkMi)
      ) {
        await this.inspect();

        // wait some time before inspecting again
        await new Promise((resolve) => setTimeout(resolve, delayBetweenProfiles*1000));
      }
    } catch (err) {
      console.error(`[${this.pod}] Error getting metrics: ${err} ${(err as any)?.statusCode}`);
    }
  }

  async guard() {
    while (this.running) {
      await this.getPodUsage();
      await new Promise((resolve) => setTimeout(resolve, metricsPollInterval*1000));
    }
  }

  async sendSignal() {
    try {
      const command = ["kill", "-USR1", "1"];
      const stream = await exec.exec(
        namespace,
        this.pod,
        container,
        command,
        new Writable({ write: () => {} } ),
        process.stderr,
        new Readable({ read() {}}),
        true /* tty */
      );
      stream.on("close", (code, signal) => {
        console.log(`[${this.pod}] Process exited with code ${code} and signal ${signal}`);
      });
      stream.on("error", (err) => {
        console.error(`[${this.pod}] Error sending signal: ${err}  ${(err as any)?.statusCode}`);
      });
    } catch (err) {
      console.error(`[${this.pod}] Error sending signal: ${err}  ${(err as any)?.statusCode}`);
    }
  }


  private httpGet(url: string) {
    return new Promise((resolve, reject) => {
      http.get(url, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          resolve(JSON.parse(data));
        });

        res.on("error", (error) => {
          reject(error);
        });
      });
    });
  }

  private async sendMessage(ws: WebSocket, cmd: string) {
    ws.send(
      JSON.stringify({
        id: 1,
        method: cmd,
      })
    );

    const message: string = await new Promise((resolve) => {
      ws.once("message", resolve);
    });

    const parsed = JSON.parse(message).result;
    //console.log(`[${this.pod}] received: `, parsed);
    return parsed;
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private timeout(ms: number) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        reject(new Error(`[${this.pod}] Request timed out`));
      }, ms);
    });
  }

  async inspect() {
    let server: net.Server | null = null;
    let pfws: WebSocket | null = null;
    try {
      await this.sendSignal();
      console.log(`[${this.pod}] Start debugger`);

      // start port forward
      server = net.createServer(async (socket) => {
        pfws = <WebSocket>await portforward.portForward(namespace, this.pod, [9229], socket, null, socket);
      });

      server.listen(0, '127.0.0.1');
      await new Promise((resolve) => {
        server!.on('listening', () => { resolve(true); })
      });
      console.log(`[${this.pod}] Started port forwarding`);


      const host = "127.0.0.1";
      const port = (<AddressInfo>server.address())?.port;

      const sessions: any = await this.httpGet(`http://${host}:${port}/json/list`);

      await new Promise((resolve, reject) => {
        if (sessions.length > 0) {
          console.log(
            `[${this.pod}] Connected to the first session `,
            sessions[0].webSocketDebuggerUrl
          );
          const wsUrl = sessions[0].webSocketDebuggerUrl;
          const ws = new WebSocket(wsUrl);

          ws.on("open", async () => {
            console.log(`[${this.pod}] Connected to debugger`);

            // await sendMessageForMessage(ws, "Runtime.enable");

            if (cpuProfiling > 0) {
              console.log(`[${this.pod}] Start cpu profiling for ${cpuProfiling} seconds`)
              await this.sendMessage(ws, "Profiler.enable");
              await this.sendMessage(ws, "Profiler.start");

              await this.sleep(cpuProfiling * 1000);
              let results = await this.sendMessage(ws, "Profiler.stop");

              let timestamp = Date.now();
              let filename = `cpu_profile_${this.pod}_${timestamp}.cpuprofile`;
              fs.writeFileSync(
                filename,
                JSON.stringify(results.profile, null, 2)
              );
              console.log(`[${this.pod}] New cpu profile ${filename} saved`)
            }

            // heap profiler
            if (heapProfiling > 0) {
              console.log(`[${this.pod}] Start heap profiling for ${heapProfiling} seconds`)
              await this.sendMessage(ws, "HeapProfiler.enable");
              await this.sendMessage(ws, "HeapProfiler.startSampling");

              await this.sleep(heapProfiling * 1000);
              let results = await this.sendMessage(
                ws,
                "HeapProfiler.stopSampling"
              );

              let timestamp = Date.now();
              let filename = `heap_profile_${this.pod}_${timestamp}.heapprofile`;
              fs.writeFileSync(
                filename,
                JSON.stringify(results.profile, null, 2)
              );
              console.log(`[${this.pod}] New heap profile ${filename} saved`)
            }

            ws.close();
          });

          ws.on("close", () => {
            console.log(`[${this.pod}] Debugger disconnected`);
            resolve(true);
          });

          ws.on("error", (err) => {
            console.log(`[${this.pod}] Debugger error: ${err}`);
            reject(err);
          })
        } else {
          console.log(`[${this.pod}] No active debug sessions`);
        }
      });
    } catch (error) {
      console.error(`[${this.pod}] Error inspecting: ${error}  ${(error as any)?.response?.message}`);
    } finally {
      if (pfws) {
        (<WebSocket>pfws).terminate();
      }
      if (server) {
        server.close();
      }
      console.log(`[${this.pod}] Stopped port forwarding`)
    }
  }
}

const monitoredPods = new Map();

const  watcher = async () => { 
  for(;;) {
    console.log("... watch");
    try {
      await new Promise( (resolve, reject) => {
      watch.watch(
      `/api/v1/namespaces/${namespace}/endpoints`,
      {
        allowWatchBookmarks: true,
        fieldSelector: `metadata.name=${serviceName}`,
      },
      // Callback for when a change occurs
      (type, endpoint: k8s.V1Endpoints) => {
        //console.log(`Change occurred: ${type}`, endpoint);

        const newDiscoveredPods = new Map();

        if (!endpoint) {
          return;
        }

        if (!endpoint.subsets) {
          return;
        }

        const subsets = endpoint.subsets;
        subsets.forEach((subset) => {
          if (subset.addresses) {
            subset.addresses.forEach((address) => {
              if (address?.targetRef) {
                newDiscoveredPods.set(address.targetRef.name, address);
              }
            });
          }
        });

        // compute the new pods to monitor and the old pods to stop monitor
        const podsToMonitor = new Map();
        const podsToStopMonitor = new Map();

        newDiscoveredPods.forEach((value, key) => {
          if (!monitoredPods.has(key)) {
            podsToMonitor.set(key, value);
          }
        });

        monitoredPods.forEach((value, key) => {
          if (!newDiscoveredPods.has(key)) {
            podsToStopMonitor.set(key, value);
          }
        });

        // delete the guardians of pods that are no longer monitored
        podsToStopMonitor.forEach((value, key) => {
          value.stop();
          monitoredPods.delete(key);
        });

        // create the guardians of pods that are newly monitored
        podsToMonitor.forEach((value, key) => {
          const guardian = new NodeGuardian(key, value.ip);
          monitoredPods.set(key, guardian);
        });
      },
      // Callback for when an error occurs
      (err) => {
        if (err) {
          console.log(`Error watching: ${err}`);
          reject(err);
        } else {
          console.log("Terminated watching")
          resolve(true);
        }
      }
      );
      });
    } catch(err) {
      console.log("Retry watching...")
    }
  }
}

watcher();
