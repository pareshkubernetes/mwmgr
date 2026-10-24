/** A stack shaped like the ones in the devfile registry: tools container, editor mount, venv and home volumes. */
export const SAMPLE_DEVFILE_YAML = `schemaVersion: 2.2.0
metadata:
  name: java-maven
  displayName: Java Maven
  description: Java 17 with Maven
commands:
  - id: build
    exec:
      component: tools
      commandLine: mvn package
events:
  postStart:
    - build
components:
  - name: tools
    container:
      image: registry.example.net/udi:latest
      memoryLimit: 4Gi
      memoryRequest: 1Gi
      cpuLimit: 2000m
      cpuRequest: 500m
      env:
        - name: FOO
          value: bar
      endpoints:
        - name: http
          targetPort: 8080
      volumeMounts:
        - name: venv
          path: /home/user/.venv
        - name: checode
          path: /checode
  - name: venv
    volume:
      size: 1Gi
  - name: checode
    volume: {}
  - name: home
    volume:
      size: 2Gi
`;

export const SAMPLE_PAT = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;
