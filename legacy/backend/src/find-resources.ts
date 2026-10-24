type Component = {
    name: string;
    cpuLimit?: number;
    memoryLimit?: number;
    volume?: {
      size: number;
    };
  };
  
  type Resource = {
    spec: {
      components: Component[];
    };
  };
  
  function processResources(resources: Resource[]): { cpu?: number; memory?: number; storage?: number } {
    const components = resources[0]?.spec.components;
  
    if (!components || components.length < 4) {
      throw new Error("Insufficient components in resources[0].spec.components");
    }
  
    let cpu = 0;
    let memory = 0;
    let storage = 0;
  
    components.forEach((component, index) => {
      if (component.name === "venv") {
        storage = component.volume?.size ?? 0; // Use the `volume.size` from the current iteration
      } else if (component.name !== "venv" && component.name !== "checode") {
        // Add CPU and memory limits from specific indices (0 and 3 in this example)
        cpu = (components[0]?.cpuLimit ?? 0) + (components[3]?.cpuLimit ?? 0);
        memory = (components[0]?.memoryLimit ?? 0) + (components[3]?.memoryLimit ?? 0);
      }
    });
  
    return { cpu, memory, storage };
  }
  
  // Example Usage
  const resources: Resource[] = [
    {
      spec: {
        components: [
          { name: "random1", cpuLimit: 2, memoryLimit: 1024 },
          { name: "random2" },
          { name: "checode", volume: { size: 100 } },
          { name: "venv", cpuLimit: 3, memoryLimit: 2048, volume: { size: 200 } },
        ],
      },
    },
  ];
  
  const result = processResources(resources);
  console.log(result);
  // Output: { cpu: 5, memory: 3072, storage: 200 }
  