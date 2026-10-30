// Builds amd64 + arm64 .deb packages and publishes them to apt.logship.de.
// Tags vX.Y.Z → stable channel, every main build → beta.
pipeline {
  agent any
  options { timestamps(); disableConcurrentBuilds() }
  environment {
    NODE_VERSION = '22.22.3'
  }
  stages {
    stage('Version') {
      steps {
        script {
          def tag = sh(script: 'git describe --tags --exact-match 2>/dev/null || true', returnStdout: true).trim()
          env.CHANNEL = tag ? 'stable' : 'beta'
          env.VERSION = tag ? tag.replaceFirst(/^v/, '') : sh(script: "node -p \"require('./package.json').version\"", returnStdout: true).trim() + "~beta${env.BUILD_NUMBER}"
          echo "building ${env.VERSION} → ${env.CHANNEL}"
        }
      }
    }
    stage('Typecheck') { steps { sh 'npm ci --no-audit --no-fund && npm run typecheck' } }
    stage('Package')   { steps { sh 'VERSION=$VERSION ./scripts/build.sh' } }
    stage('Publish') {
      steps {
        sshagent(credentials: ['edge-logship-apt']) {
          sh '''
            scp -o StrictHostKeyChecking=accept-new dist/*.deb apt@edge.logship.de:/tmp/
            ssh apt@edge.logship.de "for d in /tmp/logship-print-agent_${VERSION}_*.deb; do reprepro -b /var/www/apt includedeb ${CHANNEL} \\$d && rm -f \\$d; done"
          '''
        }
      }
    }
  }
  post { always { archiveArtifacts artifacts: 'dist/*.deb', fingerprint: true, allowEmptyArchive: true } }
}
