use fiducia_operator::FiduciaCluster;
use kube::CustomResourceExt;

fn main() {
    let yaml = serde_yaml::to_string(&FiduciaCluster::crd()).expect("serialize FiduciaCluster CRD");
    print!("{yaml}");
}
